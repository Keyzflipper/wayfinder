# Wayfinder

Point your camera at something — Wayfinder identifies it, shows what's nearby, and pulls in any relevant excerpt from travel notes you've added for the trip. Or just walk — walking mode narrates what's worth seeing and eating nearby on its own, no photo required.

Personal-scope PWA: single-user, no auth, built to run entirely on Cloudflare's free tier.

## What it does

- **Identify** — snap a photo, Claude Vision names it and gives a couple sentences of context
- **Nearby** — Mapbox surfaces points of interest within a mile of your current location
- **Good restaurants nearby** — Google Places surfaces well-reviewed restaurants within a mile, ranked by rating and review count, not just proximity
- **Travel notes** — paste or type notes for a trip; Wayfinder finds the specific places mentioned, geocodes them via Mapbox, and matches them against wherever you're standing when you take a photo
- **Walking mode** — checks your live GPS in the background as you walk and speaks up when something's worth knowing about, within a mile: a travel note (if you've added any for the trip), a notable nearby point of interest — with a real "why it's worth seeing" blurb from a live web search via Claude, not just a name and category — or a well-reviewed restaurant. At most one at a time, spoken aloud (via the Web Speech API — plays through Bluetooth-connected glasses/headphones automatically, that's just normal OS audio routing) plus an auto-dismissing banner. No photo required, no notes required. Only works while the app/tab is open; a web app can't watch location once it's backgrounded or closed
- **Trips** — every identify and note is scoped to a trip; browse past finds with their photos, or switch trips, from one sheet
- **Offline-aware PWA** — installable, with a service worker that keeps the app shell available and degrades gracefully without a connection

## Architecture

One Cloudflare Worker serves both the API and the static frontend from the same origin — `wrangler.toml`'s `[assets]` block points at `../frontend`. Anything under `/api/*` reaches `src/index.ts`'s router; everything else is served as a static file, with unmatched requests (every `/api/*` route) falling through to the Worker automatically.

| | |
|---|---|
| **Backend** | TypeScript, Cloudflare Workers |
| **Data** | D1 (trips, saved finds, guide chunks), R2 (photos) |
| **Vision / text** | Claude — Sonnet for photo identification and web-search place descriptions, Haiku for place-name extraction from notes — routed through Cloudflare AI Gateway |
| **Maps** | Mapbox — Tilequery for nearby POIs, Geocoding for note place names |
| **Restaurant ratings** | Google Places — Nearby Search, filtered by rating and review count |
| **Frontend** | Vanilla JS, no build step — Tailwind via CDN |
| **Testing** | Vitest + `@cloudflare/vitest-pool-workers` — runs against real `workerd`, not a mock |

Travel notes used to be PDF/EPUB file uploads, parsed server-side (`unpdf`, `fflate`, `fast-xml-parser`). That's gone — parsing arbitrary guidebooks fought Workers' platform limits (100MB request bodies, a 128MB memory ceiling that doesn't scale with plan) for marginal benefit over just typing or pasting the text you actually want matched. The underlying `guide_chunks` table and matching logic are unchanged, so nothing about how notes get matched to location changed — only how they get in.

## API

| Route | Method | Purpose |
|---|---|---|
| `/api/identify` | POST | Photo → Claude Vision identification + nearby POIs + note match |
| `/api/nearby` | GET | Standalone POI lookup by coordinates (~1 mile default) |
| `/api/restaurants` | GET | Well-reviewed restaurants near coordinates (~1 mile default) |
| `/api/describe` | GET | Live web-search-sourced blurb about one named place — walking mode's POI narration |
| `/api/guide` | POST | Add travel notes (plain text) for a trip |
| `/api/guide/nearby` | GET | Ranked note search by coordinates |
| `/api/trips` | GET | List trips, most recently active first |
| `/api/finds` | GET | A trip's saved finds |
| `/api/photos` | GET | Stream a stored photo back out of R2 |

## Project layout

```
wayfinder/
├── backend/           Cloudflare Worker
│   ├── src/
│   │   ├── routes/    one file per endpoint
│   │   ├── lib/       shared logic — claude, mapbox, googlePlaces, geo, trips, guideChunks, http
│   │   ├── db/schema.sql
│   │   └── types/
│   ├── test/          vitest, runs against real workerd
│   └── scripts/       test-identify.sh, upload-guides.mjs
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
GOOGLE_PLACES_API_KEY=AIza...
```

`GOOGLE_PLACES_API_KEY` needs the **Places API** enabled on a Google Cloud project with billing on file (Nearby Search isn't available on Google's no-billing free tier). `ANTHROPIC_API_KEY` needs web search enabled on the Anthropic account for `/api/describe` to return real results — without it, that route just always returns `{ description: null }` and walking mode falls back to the plain templated announcement for POIs.

Fill in `wrangler.toml`'s `database_id` (from `wrangler d1 create wayfinder-db`) and `CLOUDFLARE_ACCOUNT_ID` (from `wrangler whoami`). You'll also need an AI Gateway matching `AI_GATEWAY_ID` — create one in the dashboard (**AI → AI Gateway**) with the same name, and turn its **Authenticated Gateway** setting off (this app authenticates to Anthropic directly via `ANTHROPIC_API_KEY`, not through the gateway's own token).

```bash
npm run db:schema:local   # apply the D1 schema locally
npm run dev                # wrangler dev — serves the full app at :8787
```

## Bulk-adding travel notes

Rather than pasting each note by hand through the phone UI, drop `.txt` files into `wayfinder/backend/guides/` (gitignored — it's a local drop folder, not a place to check files in) and run:

```bash
npm run guides:upload
```

Each file becomes its own trip, named after the filename (`Rome.txt` → trip "Rome"). Pass `--trip "Name"` to upload every file in the folder under one shared trip instead, and `--url <baseUrl>` to target the deployed Worker instead of local dev (the default):

```bash
node scripts/upload-guides.mjs ./guides --url https://wayfinder-api.kokenziekw.workers.dev
```

It calls the same `/api/guide` endpoint the app does, so every file still goes through the real place-extraction/geocoding pipeline — this is a faster way to trigger that for a batch of files, not a way around it.

## Testing

```bash
npm run typecheck
npm test               # full suite, real D1/R2/fetch via @cloudflare/vitest-pool-workers
npm run test:identify   # exercise POST /api/identify against a running `wrangler dev`, no frontend needed
```

## Deploying

R2 needs to be enabled on the account once (dashboard → **Storage & databases → R2**) before a first deploy can provision the `wayfinder-photos` bucket.

```bash
npm run db:schema:remote
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put MAPBOX_TOKEN
npx wrangler secret put GOOGLE_PLACES_API_KEY
npm run deploy
```
