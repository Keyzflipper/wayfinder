// routes/restaurants.ts — GET /api/restaurants
//
// "Good restaurants nearby": same shape as routes/nearby.ts, but sourced
// from Google Places (which carries ratings/review counts) instead of
// Mapbox Tilequery (which only knows a POI exists, not whether it's good).
// Standalone and stateless, same as /api/nearby — no D1/R2 involved.

import type { Env, NearbyRestaurant } from '../types';
import { fetchNearbyRestaurants } from '../lib/googlePlaces';
import { formatDistance } from '../lib/format';
import { jsonError, parseCoord, parsePositiveInt } from '../lib/http';

const DEFAULT_RADIUS_METERS = 1000;
const MAX_RADIUS_METERS = 5000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20; // mirrors googlePlaces.ts's own ceiling

export async function handleRestaurants(request: Request, env: Env): Promise<Response> {
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

  const restaurants = await fetchNearbyRestaurants(env, lat, lon, { radiusMeters: radius, limit });
  const results: NearbyRestaurant[] = restaurants.map((r) => ({
    name: r.name,
    rating: r.rating,
    userRatingsTotal: r.userRatingsTotal,
    priceLevel: formatPriceLevel(r.priceLevel),
    address: r.address,
    distance: formatDistance(r.distanceMeters),
    openNow: r.openNow,
  }));

  return new Response(JSON.stringify({ restaurants: results }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function formatPriceLevel(level: number | null): string | null {
  if (level === null) return null;
  return '$'.repeat(Math.max(1, level));
}
