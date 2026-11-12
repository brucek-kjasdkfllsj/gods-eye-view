# Deploying to Vercel (with Neon)

This fork runs God's Eye View as a hosted Vercel app. Upstream runs everything
inside the Vite dev server: the browser app plus about 40 `/api/*` provider
proxies (ADS-B, AIS, CelesTrak, Overpass, OpenAI Realtime, and others),
installed as Vite middleware. On Vercel, the app is split into two parts:

| Piece                        | Where it runs                                                    |
| ---------------------------- | ---------------------------------------------------------------- |
| Browser app (`vite build`)   | Vercel static hosting (`dist/`)                                  |
| `/api/*` provider middleware | One Node.js Vercel Function, `api/[...path].js`                  |
| Shared upstream cache        | Neon Postgres (`gev_api_cache` table, created automatically)     |

The provider code is the upstream code, unchanged. `server/vercel/app.js` builds
the same connect middleware chain that the Vite plugins install, then hands
each request to it.

## One-time setup

1. **Import the repo:** Vercel → Add New → Project → pick this repo. The
   framework, build command and output directory come from `vercel.json`.
2. **Add Neon:** Project → Storage → Create Database → **Neon** (Vercel
   Marketplace). This sets `DATABASE_URL` for every environment. You don't
   need to run a migration: the cache table is created on first use.
   Without `DATABASE_URL` the app still works, but nothing is cached across
   function instances.
3. **Add keys (all optional):** Project → Settings → Environment Variables. The
   names are the same as in `.env.example`:
   - `GOOGLE_MAPS_API_KEY`, `CESIUM_ION_TOKEN`, `MAPILLARY_CLIENT_TOKEN`:
     injected into the browser bundle **at build time**, so you have to
     redeploy after changing them. Restrict them by HTTP referrer to your
     Vercel domain.
   - `OPENAI_API_KEY` (voice and chat), `GEMINI_API_KEY`, `TOMTOM_API_KEY`,
     `FIRMS_MAP_KEY`, `AISSTREAM_API_KEY`, OpenSky credentials, and others:
     server-side only.
4. Deploy.

## What's different from local

- **No Provider Settings writes.** `/api/setup/*` is not installed, the same as
  under `vite preview`. Manage keys in Vercel, not from the POWER UP panel.
- **No local MCP endpoint (`/mcp`)** and no ChatGPT/Codex OAuth voice login:
  both depend on the local machine.
- **Disk caches go to `/tmp`** and last only as long as a function instance.
  Neon fronts the slow-changing, rate-sensitive routes so that cold instances
  don't hit public upstreams again. CelesTrak, Overpass and Nominatim
  throttle or ban repeat traffic. The TTLs are in `server/vercel/neonCache.js`.
  Responses carry `X-GEV-Neon-Cache: HIT|MISS`.
- **Long-lived upstream streams are best effort.** The live AIS vessel feed
  keeps a websocket open in the server process. On Vercel that websocket lives
  only while a function instance is warm, so vessels can take a moment to fill
  in after a cold start.
- **Per-IP rate limits are per instance**, not global.
- **Nominatim:** the public instance allows about 1 request/s for each
  application. Every instance keeps its own gate, so for heavy use set
  `NOMINATIM_URL` to your own instance, or add a Google key (geocoding then
  goes to Google first).

## Local development

Nothing changes: `npm ci && npm run dev` still runs the full upstream dev
server. To exercise the function path locally, use `vercel dev`.
