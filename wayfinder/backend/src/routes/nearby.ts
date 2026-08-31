// routes/nearby.ts — GET /api/nearby
//
// Standalone POI lookup: given coordinates (no photo required), return
// nearby points of interest. Unlike /api/identify, this never touches
// D1 or R2 — it's a thin, stateless wrapper around lib/mapbox.ts for
// "what's around me right now" without a shutter capture.

import type { Env, NearbyPlace } from '../types';
import { fetchNearbyPois } from '../lib/mapbox';
import { formatDistance } from '../lib/format';

const DEFAULT_RADIUS_METERS = 500;
const MAX_RADIUS_METERS = 2000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50; // mirrors mapbox.ts's own ceiling

export async function handleNearby(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const params = url.searchParams;

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

  const pois = await fetchNearbyPois(env, lat, lon, { radiusMeters: radius, limit });
  const nearby: NearbyPlace[] = pois.map((poi) => ({
    name: poi.name,
    category: poi.category,
    distance: formatDistance(poi.distanceMeters),
  }));

  return new Response(JSON.stringify({ nearby }), {
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

// Returns `fallback` when `raw` is absent, `null` when `raw` is present but invalid.
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
