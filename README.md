# Wayfinder

Point your camera at something — Wayfinder identifies it, shows what's nearby, and pulls in any relevant excerpt from a travel guide you've uploaded for the trip.

Personal-scope PWA: single-user, no auth, built to run entirely on Cloudflare's free tier.

## What it does

- **Identify** — snap a photo, Claude Vision names it and gives a couple sentences of context
- **Nearby** — Mapbox surfaces points of interest around your current location
- **Travel guides** — upload a PDF for a trip; Wayfinder extracts its text, asks Claude to find the one specific place each excerpt is about, geocodes it via Mapbox, and matches excerpts against wherever you're standing when you take a photo
- **Trips** — every identify and guide upload is scoped to a trip; browse past finds with their photos, or switch trips, from one sheet
- **Offline-aware PWA** — installable, with a service worker that keeps the app shell available and degrades gracefully without a connection

## Architecture

One Cloudflare Worker serves both the API and the static frontend from the same origin — `wrangler.toml`'s `[assets]` block points at `../frontend`. Anything under `/api/*` reaches `src/index.ts`'s router; everything else is served as a static file, with unmatched requests (every `/api/*` route) falling through to the Worker automatically.

| | |
|---|---|
| **Backend** | TypeScript, Cloudflare Workers |
| **Data** | D1 (trips, saved finds, guide chunks), R2 (photos, guide PDFs) |
| **Vision / text** | Claude — Sonnet for photo identification, Haiku for guide-chunk place extraction — routed through Cloudflare AI Gateway |
| **Maps** | Mapbox — Tilequery for nearby POIs, Geocoding for guide-chunk place names |
| **PDF parsing** | [unpdf](https://github.com/unjs/unpdf) |
| **Frontend** | Vanilla JS, no build step — Tailwind via CDN |
| **Testing** | Vitest + `@cloudflare/vitest-pool-workers` — runs against real `workerd`, not a mock |

## API

| Route | Method | Purpose |
|---|---|---|
| `/api/identify` | POST | Photo → Claude Vision identification + nearby POIs + guide match |
| `/api/nearby` | GET | Standalone POI lookup by coordinates |
| `/api/guide` | POST | Upload a PDF guide for a trip |
| `/api/guide/nearby` | GET | Ranked guide-chunk search by coordinates |
| `/api/trips` | GET | List trips, most recently active first |
| `/api/finds` | GET | A trip's saved finds |
| `/api/photos` | GET | Stream a stored photo back out of R2 |

## Project layout

```
wayfinder/
├── backend/           Cloudflare Worker
│   ├── src/
│   │   ├── routes/    one file per endpoint
│   │   ├── lib/       shared logic — claude, mapbox, geo, trips, guideChunks, http
│   │   ├── db/schema.sql
│   │   └── types/
│   ├── test/          vitest, runs against real workerd
│   └── scripts/       test-identify.sh, generate-test-pdf.mjs
└── frontend/           PWA — index.html, main.js, sw.js, manifest.json
```

## Local development

From `wayfinder/backend`:

```bash
npm install
```

Create `.dev.vars` (gitignored — never commit this) with your own keys:

```
ANTHROPIC_API_KEY=sk-ant-...
MAPBOX_TOKEN=pk....
```

Fill in `wrangler.toml`'s `database_id` (from `wrangler d1 create wayfinder-db`) and `CLOUDFLARE_ACCOUNT_ID` (from `wrangler whoami`). You'll also need an AI Gateway matching `AI_GATEWAY_ID` — create one in the dashboard (**AI → AI Gateway**) with the same name, and turn its **Authenticated Gateway** setting off (this app authenticates to Anthropic directly via `ANTHROPIC_API_KEY`, not through the gateway's own token).

```bash
npm run db:schema:local   # apply the D1 schema locally
npm run dev                # wrangler dev — serves the full app at :8787
```

## Testing

```bash
npm run typecheck
npm test               # full suite, real D1/R2/fetch via @cloudflare/vitest-pool-workers
npm run test:identify   # exercise POST /api/identify against a running `wrangler dev`, no frontend needed
```

## Deploying

R2 needs to be enabled on the account once (dashboard → **Storage & databases → R2**) before a first deploy can provision the `wayfinder-photos`/`wayfinder-guides` buckets.

```bash
npm run db:schema:remote
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put MAPBOX_TOKEN
npm run deploy
```
