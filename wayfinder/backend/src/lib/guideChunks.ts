// lib/guideChunks.ts — proximity search over a trip's guide_chunks.
// Split out of routes/identify.ts (which only ever wanted the single
// nearest match) once routes/guide-lookup.ts needed the same search but
// returning several ranked matches instead of just one.
//
// Two-step lookup, same shape as lib/mapbox.ts's approach: a cheap SQL
// bounding-box prefilter (fast, but not circular — it over-selects near
// the box's corners), then an exact haversine distance refine + sort in
// JS over that smaller candidate set.

import type { Env } from '../types';
import { haversineMeters } from './geo';

const DEFAULT_LIMIT = 5;
// SQL bounding-box candidates are capped before the exact haversine
// refine — bounds worst case in a dense area while still comfortably
// covering any caller-provided `limit` after the circular filter.
const MAX_CANDIDATES = 100;

export interface NearbyGuideChunk {
  id: string;
  text: string;
  sourcePage: number | null;
  distanceMeters: number;
}

export interface FindNearbyGuideChunksOptions {
  radiusMeters: number;
  limit?: number;
}

export async function findNearbyGuideChunks(
  env: Env,
  tripId: string,
  lat: number,
  lon: number,
  opts: FindNearbyGuideChunksOptions
): Promise<NearbyGuideChunk[]> {
  const { radiusMeters, limit = DEFAULT_LIMIT } = opts;

  const latDelta = radiusMeters / 111320;
  const lonDelta = radiusMeters / (111320 * Math.cos((lat * Math.PI) / 180));

  const candidates = await env.DB.prepare(
    `SELECT id, text, source_page, lat, lon FROM guide_chunks
     WHERE trip_id = ? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
     LIMIT ?`
  )
    .bind(tripId, lat - latDelta, lat + latDelta, lon - lonDelta, lon + lonDelta, MAX_CANDIDATES)
    .all<{ id: string; text: string; source_page: number | null; lat: number; lon: number }>();

  if (!candidates.results || candidates.results.length === 0) return [];

  const withinRadius: NearbyGuideChunk[] = [];
  for (const row of candidates.results) {
    const distanceMeters = haversineMeters(lat, lon, row.lat, row.lon);
    if (distanceMeters <= radiusMeters) {
      withinRadius.push({ id: row.id, text: row.text, sourcePage: row.source_page, distanceMeters });
    }
  }

  withinRadius.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return withinRadius.slice(0, limit);
}
