-- schema.sql — Wayfinder D1 schema
-- SQLite (via Cloudflare D1). Coordinates use REAL (8-byte double) for
-- full GPS precision. Timestamps are ISO 8601 strings in UTC.

PRAGMA foreign_keys = ON;

-- ============================================================
-- trips
-- One row per trip. Currently mirrors the client-side trip name
-- kept in localStorage (main.js) — this is the server-side source
-- of truth once the backend is wired up.
-- ============================================================
CREATE TABLE IF NOT EXISTS trips (
  id         TEXT PRIMARY KEY,                                   -- uuid, generated client- or server-side
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================
-- saved_finds
-- One row per shutter capture: the photo, where it was taken,
-- and the identification result. This is what populates the
-- results sheet in main.js and what /api/identify writes to.
-- ============================================================
CREATE TABLE IF NOT EXISTS saved_finds (
  id               TEXT PRIMARY KEY,                             -- uuid
  trip_id          TEXT REFERENCES trips(id) ON DELETE SET NULL, -- nullable: a find can exist with no trip set
  photo_key        TEXT NOT NULL,                                -- R2 object key for the captured photo
  lat              REAL,                                         -- nullable: GPS may have been denied (see main.js soft-degrade)
  lon              REAL,
  accuracy_m       REAL,                                         -- GPS accuracy in meters, as reported by the browser
  name             TEXT,                                         -- identification result, e.g. "Mallory Square"
  detail           TEXT,                                         -- longer description from Claude Vision
  confidence       REAL,                                         -- 0.0–1.0
  guide_chunk_id   TEXT REFERENCES guide_chunks(id) ON DELETE SET NULL, -- set if a guide excerpt matched this location
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))  -- maps to `cachedAt` in API responses
);

-- ============================================================
-- guide_chunks
-- Chunks of an uploaded travel guide PDF, geocoded where possible
-- so they can be matched against a find's GPS coordinates.
-- ============================================================
CREATE TABLE IF NOT EXISTS guide_chunks (
  id                  TEXT PRIMARY KEY,                          -- uuid
  trip_id             TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  source_page         INTEGER,                                   -- page number in the original PDF, nullable
  text                TEXT NOT NULL,                              -- extracted chunk text
  lat                 REAL,                                       -- nullable: not every chunk mentions a geocodable place
  lon                 REAL,
  geocode_confidence  REAL,                                       -- 0.0–1.0, confidence in the place-name -> coordinate match
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ============================================================
-- Indices
-- ============================================================

-- Look up all finds for a given trip (results history / trip log view)
CREATE INDEX IF NOT EXISTS idx_saved_finds_trip_id ON saved_finds(trip_id);

-- Proximity queries: "what have I already identified near here"
CREATE INDEX IF NOT EXISTS idx_saved_finds_lat_lon ON saved_finds(lat, lon);

-- Look up all guide chunks for a given trip (used during PDF ingestion review)
CREATE INDEX IF NOT EXISTS idx_guide_chunks_trip_id ON guide_chunks(trip_id);

-- Proximity queries: "does the guide mention anything near here"
CREATE INDEX IF NOT EXISTS idx_guide_chunks_lat_lon ON guide_chunks(lat, lon);
