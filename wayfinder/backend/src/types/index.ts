// types/index.ts — Env interface for the Wayfinder Worker.
// Every field here must match a binding or var declared in wrangler.toml,
// or a secret set via `wrangler secret put`. Keep these two files in sync —
// a mismatch here fails silently at runtime (undefined binding) rather than
// at compile time.

export interface Env {
  // ---- D1 ----
  // binding = "DB" in wrangler.toml [[d1_databases]]
  DB: D1Database;

  // ---- R2 ----
  // binding = "PHOTOS" — captured shutter photos
  PHOTOS: R2Bucket;
  // binding = "GUIDES" — uploaded travel guide PDFs
  GUIDES: R2Bucket;

  // ---- Secrets ----
  // Set via `wrangler secret put` (prod) or `.dev.vars` (local).
  // Not present in wrangler.toml — see backend/.gitignore.
  // ANTHROPIC_API_KEY is sent as the Authorization header on requests routed
  // through AI Gateway (BYOK) — the gateway proxies to Anthropic, it doesn't
  // store the key itself.
  ANTHROPIC_API_KEY: string;
  MAPBOX_TOKEN: string;
  GOOGLE_PLACES_API_KEY: string;

  // ---- Vars ----
  // Set in wrangler.toml [vars] — plain config, safe to commit.
  ENVIRONMENT: 'development' | 'production';
  MAX_PHOTO_UPLOAD_BYTES: string; // Wrangler vars are always strings; parse with Number() where used
  MAX_GUIDE_UPLOAD_BYTES: string;
  // AI Gateway routing — combine into the gateway URL:
  // https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{AI_GATEWAY_ID}/anthropic/v1/messages
  CLOUDFLARE_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
}

// ---- Domain types (shared across routes) ----

export interface Trip {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface SavedFind {
  id: string;
  trip_id: string | null;
  photo_key: string;
  lat: number | null;
  lon: number | null;
  accuracy_m: number | null;
  name: string | null;
  detail: string | null;
  confidence: number | null;
  guide_chunk_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface GuideChunk {
  id: string;
  trip_id: string;
  source_page: number | null;
  text: string;
  lat: number | null;
  lon: number | null;
  geocode_confidence: number | null;
  created_at: string;
}

// ---- API response shapes ----
// Matches what frontend/src/main.js's renderResults() already expects.

export interface NearbyPlace {
  name: string;
  category: string | null;
  distance: string; // pre-formatted, e.g. "180m" — formatting stays server-side
}

export interface IdentifyResponse {
  name: string;
  detail: string;
  confidence: number;
  guideExcerpt: string | null;
  nearby: NearbyPlace[];
  cachedAt: string; // maps to saved_finds.updated_at — lets the UI flag stale data
  tripId: string | null; // lets the client call GET /api/guide/nearby for more excerpts without re-deriving the trip
}

export interface GuideUploadResponse {
  tripId: string;
  totalPages: number;
  chunksCreated: number;
  chunksGeocoded: number;
  truncated: boolean; // true if the PDF had more chunks than a single upload processes — see routes/guide-upload.ts's MAX_CHUNKS
}

export interface NearbyGuideChunkResult {
  id: string;
  text: string;
  sourcePage: number | null;
  distance: string; // pre-formatted, same convention as NearbyPlace.distance
}

export interface NearbyRestaurant {
  name: string;
  rating: number;
  userRatingsTotal: number;
  priceLevel: string | null; // "$".."$$$$" — pre-formatted, same convention as NearbyPlace.distance
  address: string | null;
  distance: string;
  openNow: boolean | null;
}

export interface TripSummary {
  id: string;
  name: string;
  findCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TripFindSummary {
  id: string;
  name: string | null;
  detail: string | null;
  confidence: number | null;
  photoUrl: string; // GET /api/photos?key=... — the client never sees a raw R2 key
  lat: number | null;
  lon: number | null;
  createdAt: string;
}
