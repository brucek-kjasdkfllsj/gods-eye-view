/**
 * Shared, durable response cache for the Vercel deployment, stored in Neon
 * Postgres.
 *
 * The local dev server keeps provider answers in `.gev-cache/` on disk. On
 * Vercel every function instance has its own short-lived `/tmp`, so a cold
 * instance would re-fetch from public upstreams (CelesTrak, Overpass,
 * Nominatim, Launch Library, ...) whose usage policies punish repeat traffic.
 * This cache sits in front of the provider middleware: a successful GET answer
 * on an allow-listed route is stored once and served to every instance until
 * its TTL expires.
 *
 * With no DATABASE_URL the cache is a no-op and the app behaves exactly like
 * an uncached deployment.
 */
import { neon } from '@neondatabase/serverless';

/** Per-route TTLs (seconds). Only these GET routes are cached. */
export const CACHE_TTL_SECONDS = Object.freeze([
  ['/api/celestrak-satcat', 6 * 3600],
  ['/api/celestrak', 2 * 3600],
  ['/api/launches', 10 * 60],
  ['/api/overpass', 24 * 3600],
  ['/api/osm/features', 24 * 3600],
  ['/api/military-installations', 7 * 24 * 3600],
  ['/api/geocode', 7 * 24 * 3600],
  ['/api/terrain/heights', 30 * 24 * 3600],
  ['/api/adsbdb', 24 * 3600],
  ['/api/shipwrecks', 7 * 24 * 3600],
  ['/api/ghostmaps', 24 * 3600],
  ['/api/drone-airspace', 24 * 3600],
  ['/api/fire-perimeters', 15 * 60],
  ['/api/firms', 10 * 60],
  ['/api/cyclones', 15 * 60],
  ['/api/gnss-integrity', 15 * 60],
  ['/api/news', 5 * 60],
  ['/api/inaturalist', 60 * 60],
  ['/api/regional-brief', 30 * 60],
  ['/api/weather-effects', 15 * 60],
]);

/** Largest body worth putting in a row; bigger answers pass through uncached. */
export const MAX_CACHED_BYTES = 4 * 1024 * 1024;

/** Response types never cached (streams, media). */
const UNCACHEABLE_TYPE = /^(audio|video|image)\/|event-stream|multipart/i;

/** Headers replayed from a cached answer. */
const REPLAYED_HEADERS = ['content-type', 'content-encoding', 'x-gev-source'];

/** TTL for a request path, or 0 when the route is not cached. */
export function ttlForPath(pathname) {
  for (const [prefix, ttl] of CACHE_TTL_SECONDS) {
    if (
      pathname === prefix ||
      pathname.startsWith(`${prefix}/`) ||
      pathname.startsWith(`${prefix}?`)
    )
      return ttl;
  }
  return 0;
}

let sqlClient;
let schemaReady;

function sql() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) return null;
  sqlClient ??= neon(url);
  return sqlClient;
}

async function ensureSchema(db) {
  schemaReady ??= db`
    CREATE TABLE IF NOT EXISTS gev_api_cache (
      cache_key  text PRIMARY KEY,
      status     integer NOT NULL,
      headers    jsonb NOT NULL,
      body       bytea NOT NULL,
      expires_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`
    .then(
      () =>
        db`CREATE INDEX IF NOT EXISTS gev_api_cache_expires_idx
           ON gev_api_cache (expires_at)`,
    )
    .catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  return schemaReady;
}

/** Whether the Neon cache is configured for this deployment. */
export function neonCacheEnabled() {
  return Boolean(sql());
}

/** Read a fresh cached answer, or null. Never throws. */
export async function readCached(key) {
  const db = sql();
  if (!db) return null;
  try {
    await ensureSchema(db);
    const rows = await db`
      SELECT status, headers, body FROM gev_api_cache
      WHERE cache_key = ${key} AND expires_at > now()`;
    if (!rows.length) return null;
    const row = rows[0];
    return {
      status: row.status,
      headers: row.headers,
      body: Buffer.from(row.body),
    };
  } catch (error) {
    console.warn('[gev] neon cache read failed:', error.message);
    return null;
  }
}

/** Store an answer. Never throws. */
export async function writeCached(key, { status, headers, body }, ttlSeconds) {
  const db = sql();
  if (!db || !ttlSeconds) return;
  try {
    await ensureSchema(db);
    const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    await db`
      INSERT INTO gev_api_cache (cache_key, status, headers, body, expires_at)
      VALUES (${key}, ${status}, ${JSON.stringify(headers)}::jsonb,
              ${'\\x' + body.toString('hex')}::bytea, ${expires}::timestamptz)
      ON CONFLICT (cache_key) DO UPDATE SET
        status = EXCLUDED.status, headers = EXCLUDED.headers,
        body = EXCLUDED.body, expires_at = EXCLUDED.expires_at,
        updated_at = now()`;
    // Opportunistic cleanup, roughly once per hundred writes.
    if (Math.random() < 0.01)
      await db`DELETE FROM gev_api_cache WHERE expires_at < now() - interval '1 day'`;
  } catch (error) {
    console.warn('[gev] neon cache write failed:', error.message);
  }
}

/**
 * Wrap a response so the bytes written to it are also captured. Resolves the
 * returned promise with the captured answer once the response ends, or with
 * null when the answer is not cacheable.
 */
export function captureResponse(res) {
  const chunks = [];
  let size = 0;
  let overflow = false;
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  const take = (chunk, encoding) => {
    if (chunk == null || overflow) return;
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
    size += buffer.length;
    if (size > MAX_CACHED_BYTES) {
      overflow = true;
      chunks.length = 0;
      return;
    }
    chunks.push(buffer);
  };
  return new Promise((resolve) => {
    res.write = (chunk, encoding, cb) => {
      take(chunk, encoding);
      return write(chunk, encoding, cb);
    };
    res.end = (chunk, encoding, cb) => {
      if (typeof chunk !== 'function') take(chunk, encoding);
      const result = end(chunk, encoding, cb);
      const type = String(res.getHeader('content-type') || '');
      const cacheControl = String(res.getHeader('cache-control') || '');
      if (
        overflow ||
        res.statusCode !== 200 ||
        UNCACHEABLE_TYPE.test(type) ||
        /private/i.test(cacheControl)
      ) {
        resolve(null);
        return result;
      }
      const headers = {};
      for (const name of REPLAYED_HEADERS) {
        const value = res.getHeader(name);
        if (value !== undefined) headers[name] = String(value);
      }
      resolve({ status: 200, headers, body: Buffer.concat(chunks) });
      return result;
    };
  });
}
