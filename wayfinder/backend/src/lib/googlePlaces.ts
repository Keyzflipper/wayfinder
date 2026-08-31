// lib/googlePlaces.ts — "good restaurants nearby" via Google Places' Nearby
// Search API. Unlike Mapbox Tilequery (lib/mapbox.ts), which only knows a
// POI exists, Places carries a rating and review count — the actual signal
// "good" requires.
//
// Contract: matches lib/mapbox.ts — fetchNearbyRestaurants() never throws.
// Any failure (network error, non-OK response, non-OK API status) is caught
// and logged, returning [] instead, so callers don't need special-case
// error handling for "Google Places is unavailable" vs. "no restaurants here".

import type { Env } from '../types';
import { haversineMeters } from './geo';

const DEFAULT_RADIUS_METERS = 1000;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20; // Nearby Search's own per-page ceiling (pagination not implemented)
const MIN_RATING_COUNT = 5; // filters out a lone 5-star review masquerading as "good"
const REQUEST_TIMEOUT_MS = 5000;

export interface GoogleRestaurant {
  name: string;
  rating: number;
  userRatingsTotal: number;
  priceLevel: number | null; // Google's 0 (free) .. 4 (very expensive) scale
  address: string | null;
  distanceMeters: number;
  openNow: boolean | null;
  placeId: string;
}

interface PlacesResult {
  place_id: string;
  name: string;
  rating?: number;
  user_ratings_total?: number;
  price_level?: number;
  vicinity?: string;
  business_status?: string;
  geometry?: { location?: { lat: number; lng: number } };
  opening_hours?: { open_now?: boolean };
}

interface PlacesResponse {
  status: string;
  results: PlacesResult[];
}

export interface FetchRestaurantsOptions {
  radiusMeters?: number;
  limit?: number;
}

export async function fetchNearbyRestaurants(
  env: Env,
  lat: number,
  lon: number,
  opts: FetchRestaurantsOptions = {}
): Promise<GoogleRestaurant[]> {
  const radius = opts.radiusMeters ?? DEFAULT_RADIUS_METERS;
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const url = new URL('https://maps.googleapis.com/maps/api/place/nearbysearch/json');
  url.searchParams.set('location', `${lat},${lon}`);
  url.searchParams.set('radius', String(radius));
  url.searchParams.set('type', 'restaurant');
  url.searchParams.set('key', env.GOOGLE_PLACES_API_KEY);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), { signal: controller.signal });

    if (!response.ok) {
      console.warn(`Google Places Nearby Search returned ${response.status} — proceeding without restaurant data.`);
      return [];
    }

    const data = (await response.json()) as PlacesResponse;

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.warn(`Google Places Nearby Search returned status ${data.status} — proceeding without restaurant data.`);
      return [];
    }

    return parseResults(data.results ?? [], lat, lon, limit);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.warn(`Google Places Nearby Search timed out after ${REQUEST_TIMEOUT_MS}ms — proceeding without restaurant data.`);
    } else {
      console.warn('Google Places Nearby Search request failed — proceeding without restaurant data.', err);
    }
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function parseResults(results: PlacesResult[], lat: number, lon: number, limit: number): GoogleRestaurant[] {
  return results
    .filter(
      (r): r is PlacesResult & { rating: number; geometry: { location: { lat: number; lng: number } } } =>
        typeof r.rating === 'number' &&
        (r.user_ratings_total ?? 0) >= MIN_RATING_COUNT &&
        r.business_status !== 'CLOSED_PERMANENTLY' &&
        r.business_status !== 'CLOSED_TEMPORARILY' &&
        r.geometry?.location !== undefined
    )
    .map((r) => ({
      name: r.name,
      rating: r.rating,
      userRatingsTotal: r.user_ratings_total ?? 0,
      priceLevel: r.price_level ?? null,
      address: r.vicinity ?? null,
      distanceMeters: haversineMeters(lat, lon, r.geometry.location.lat, r.geometry.location.lng),
      openNow: r.opening_hours?.open_now ?? null,
      placeId: r.place_id,
    }))
    .sort((a, b) => b.rating - a.rating || b.userRatingsTotal - a.userRatingsTotal)
    .slice(0, limit);
}
