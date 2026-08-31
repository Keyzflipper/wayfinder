// routes/guide-lookup.ts — GET /api/guide/nearby
//
// Standalone guide-chunk search: given a trip and coordinates, return every
// geocoded guide_chunks excerpt within range, ranked by distance. Unlike
// identify.ts's inline guide match (which only ever wants the single
// nearest chunk to silently attach to a photo), this is an explicit search
// — it can return several results and lets the caller tune the radius.

import type { Env, NearbyGuideChunkResult } from '../types';
import { findNearbyGuideChunks } from '../lib/guideChunks';
import { formatDistance } from '../lib/format';

const DEFAULT_RADIUS_METERS = 300;
const MAX_RADIUS_METERS = 2000;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

export async function handleGuideLookup(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const params = url.searchParams;

  const tripId = params.get('tripId');
  if (tripId === null || tripId.trim().length === 0) {
    return jsonError(400, 'missing_trip_id', 'Query param "tripId" is required.');
  }

  const lat = parseCoord(params.get('lat'));
  const lon = parseCoord(params.get('lon'));
  if (lat === null || lon === null) {
    return jsonError(400, 'invalid_coords', 'Query params "lat" and "lon" are required and must be finite numbers.');
  }
  if (lat < -90 || lat > 90) {
    return jsonError(400, 'invalid_coords', '"lat" must be between -90 and 90.');
  }
  if (lon < -180 || lon > 180) {
    return jsonError(400, 'invalid_coords', '"lon" must be between -180 and 180.');
  }

  const radius = parsePositiveInt(params.get('radius'), DEFAULT_RADIUS_METERS, MAX_RADIUS_METERS);
  if (radius === null) {
    return jsonError(400, 'invalid_radius', `"radius" must be a positive integer up to ${MAX_RADIUS_METERS}.`);
  }

  const limit = parsePositiveInt(params.get('limit'), DEFAULT_LIMIT, MAX_LIMIT);
  if (limit === null) {
    return jsonError(400, 'invalid_limit', `"limit" must be a positive integer up to ${MAX_LIMIT}.`);
  }

  const matches = await findNearbyGuideChunks(env, tripId, lat, lon, { radiusMeters: radius, limit });
  const chunks: NearbyGuideChunkResult[] = matches.map((m) => ({
    id: m.id,
    text: m.text,
    sourcePage: m.sourcePage,
    distance: formatDistance(m.distanceMeters),
  }));

  return new Response(JSON.stringify({ chunks }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// ---- Helpers ----

function parseCoord(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function parsePositiveInt(raw: string | null, fallback: number, max: number): number | null {
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > max) return null;
  return value;
}

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
