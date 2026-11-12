/**
 * Runs God's Eye View's provider middleware as a Vercel Function.
 *
 * Locally, every `/api/*` route is a Vite plugin that installs connect-style
 * middleware in `configureServer`. This module builds the same chain on a
 * plain `connect` app, so the routes, validation and upstream handling are the
 * upstream code, unchanged. Differences from the local dev server:
 *
 * - Provider Settings (`/api/setup/*`) is not installed, as under
 *   `vite preview`: keys are Vercel environment variables, never written from
 *   the browser.
 * - The local MCP endpoint and the dev-only Host check are not installed;
 *   Vercel routes only its own domains to the function.
 * - Disk caches live in `/tmp` (per instance). A shared Neon Postgres cache
 *   (./neonCache.js) fronts the slow-changing upstream routes.
 */
import fs from 'node:fs';
import path from 'node:path';
import connect from 'connect';
import {
  captureResponse,
  readCached,
  ttlForPath,
  writeCached,
} from './neonCache.js';

const RUNTIME_DIR = process.env.GEV_RUNTIME_DIR || '/tmp/gev';

let appPromise;

/**
 * Same headers as build/vite.js's apiResponseHeadersPlugin (imported there
 * alongside Vite build plugins, which the function bundle should not carry).
 */
const API_CSP = "default-src 'none'; sandbox";
const apiResponseHeadersPlugin = {
  name: 'api-response-headers',
  configureServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Content-Security-Policy', API_CSP);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const setHeader = res.setHeader.bind(res);
      res.setHeader = (name, value) =>
        String(name).toLowerCase() === 'content-security-policy' &&
        String(value) !== API_CSP
          ? setHeader(name, `${API_CSP}, ${value}`)
          : setHeader(name, value);
      next();
    });
  },
};

async function buildApp() {
  // Provider modules resolve `.gev-cache` against the working directory when
  // they load. The deployment bundle is read-only, so point them at /tmp
  // before importing anything.
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  process.chdir(RUNTIME_DIR);

  const [local, standalone] = await Promise.all([
    import('../providers/local.js'),
    Promise.all([
      import('../standalone/api-not-found.js'),
      import('../standalone/google-token-unavailable.js'),
      import('../standalone/voiceTools.js'),
    ]),
  ]);
  const [
    { apiNotFoundPlugin },
    { googleTokenUnavailablePlugin },
    { standaloneVoiceTools },
  ] = standalone;

  const tools = standaloneVoiceTools();
  const providers = local
    .localProviderPlugins({
      realtime: { tools },
      gemini: process.env.GEMINI_API_KEY ? { tools } : undefined,
      nominatimStorageDir: path.join(RUNTIME_DIR, '.gev-cache', 'nominatim'),
    })
    .flat()
    .filter((plugin) => plugin && plugin.name !== 'gev-key-setup');

  const plugins = [
    apiResponseHeadersPlugin,
    ...providers,
    googleTokenUnavailablePlugin(),
    apiNotFoundPlugin(),
  ];

  const app = connect();
  const server = {
    middlewares: app,
    httpServer: null,
    config: { root: process.cwd(), command: 'serve', mode: 'production' },
  };
  const postHooks = [];
  for (const plugin of plugins) {
    if (typeof plugin.apply === 'function') {
      if (!plugin.apply({}, { command: 'serve', isPreview: true })) continue;
    } else if (plugin.apply === 'build') continue;
    const hook = plugin.configurePreviewServer || plugin.configureServer;
    if (typeof hook !== 'function') continue;
    const post = await hook.call(plugin, server);
    if (typeof post === 'function') postHooks.push(post);
  }
  for (const post of postHooks) await post();
  return app;
}

function getApp() {
  appPromise ??= buildApp().catch((error) => {
    appPromise = undefined;
    throw error;
  });
  return appPromise;
}

/** Vercel Node.js function entry: every `/api/*` request lands here. */
export default async function handler(req, res) {
  let app;
  try {
    app = await getApp();
  } catch (error) {
    console.error('[gev] provider startup failed', error);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Provider startup failed' }));
    return;
  }

  const url = new URL(req.url || '/', 'http://localhost');
  const ttl = req.method === 'GET' ? ttlForPath(url.pathname) : 0;
  const cacheKey = `${url.pathname}${url.search}`;

  if (ttl) {
    const hit = await readCached(cacheKey);
    if (hit) {
      res.statusCode = hit.status;
      for (const [name, value] of Object.entries(hit.headers))
        res.setHeader(name, value);
      res.setHeader('Content-Security-Policy', API_CSP);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-GEV-Neon-Cache', 'HIT');
      res.end(hit.body);
      return;
    }
    res.setHeader('X-GEV-Neon-Cache', 'MISS');
  }

  const captured = ttl ? captureResponse(res) : null;
  await new Promise((resolve) => {
    res.once('finish', resolve);
    res.once('close', resolve);
    app(req, res, (error) => {
      if (!res.headersSent) {
        res.statusCode = error ? 500 : 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ error: error ? 'Server error' : 'Not found' }),
        );
      }
      resolve();
    });
  });
  if (captured) {
    const answer = await captured;
    if (answer) await writeCached(cacheKey, answer, ttl);
  }
}
