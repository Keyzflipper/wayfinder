// lib/mapbox.ts — nearby point-of-interest lookup via Mapbox's Tilequery API,
// plus forward geocoding (place name -> coordinates) via the Geocoding API.
//
// Contract: neither fetchNearbyPois() nor geocodePlaceName() ever throws.
// Any failure (network error, non-OK response, rate limit) is caught and
// logged, returning [] / null instead. This lets callers (routes/nearby.ts,
// identify.ts, routes/guide-upload.ts) treat "no data" and "Mapbox is
// unavailable" identically — no special-case error handling needed
// downstream. For guide-upload.ts specifically, one chunk failing to
// geocode should never abort processing the rest of the guide.

import type { Env } from '../types';

const TILESET = 'mapbox.mapbox-streets-v8';
const POI_LAYER = 'poi_label';
const DEFAULT_RADIUS_METERS = 500;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50; // Tilequery's own ceiling
const REQUEST_TIMEOUT_MS = 5000;

export interface MapboxPoi {
  name: string;
  category: string | null;
  distanceMeters: number;
  lat: number;
  lon: number;
}

interface TilequeryFeature {
  type: 'Feature';
  properties: {
    name?: string;
    class?: string;
    maki?: string;
    'tilequery.distance'?: number;
  };
  geometry: {
    type: 'Point';
    coordinates: [number, number]; // [lon, lat]
  };
}

interface TilequeryResponse {
  type: 'FeatureCollection';
  features: TilequeryFeature[];
}

export interface FetchNearbyOptions {
  radiusMeters?: number;
  limit?: number;
}

export async function fetchNearbyPois(
  env: Env,
  lat: number,
  lon: number,
  opts: FetchNearbyOptions = {}
): Promise<MapboxPoi[]> {
  const radius = opts.radiusMeters ?? DEFAULT_RADIUS_METERS;
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  const url = new URL(`https://api.mapbox.com/v4/${TILESET}/tilequery/${lon},${lat}.json`);
  url.searchParams.set('radius', String(radius));
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('layers', POI_LAYER);
  url.searchParams.set('access_token', env.MAPBOX_TOKEN);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), { signal: controller.signal });

    if (response.status === 429) {
      console.warn('Mapbox Tilequery rate-limited (429) — proceeding without nearby data.');
      return [];
    }

    if (!response.ok) {
      console.warn(`Mapbox Tilequery returned ${response.status} — proceeding without nearby data.`);
      return [];
    }

    const data = (await response.json()) as TilequeryResponse;
    return parseFeatures(data.features);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.warn(`Mapbox Tilequery timed out after ${REQUEST_TIMEOUT_MS}ms — proceeding without nearby data.`);
    } else {
      console.warn('Mapbox Tilequery request failed — proceeding without nearby data.', err);
    }
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// ---- Forward geocoding (guide_chunks) ----

const GEOCODE_TIMEOUT_MS = 5000;

export interface GeocodedPlace {
  lat: number;
  lon: number;
  confidence: number; // Mapbox's 0..1 "relevance" score for the top match
}

interface GeocodingFeature {
  center: [number, number]; // [lon, lat]
  relevance: number;
}

interface GeocodingResponse {
  type: 'FeatureCollection';
  features: GeocodingFeature[];
}

export async function geocodePlaceName(env: Env, placeName: string): Promise<GeocodedPlace | null> {
  const url = new URL(`https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(placeName)}.json`);
  url.searchParams.set('limit', '1');
  url.searchParams.set('access_token', env.MAPBOX_TOKEN);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);

  try {
    const response = await fetch(url.toString(), { signal: controller.signal });

    if (!response.ok) {
      console.warn(`Mapbox Geocoding returned ${response.status} for "${placeName}" — leaving this chunk ungeocoded.`);
      return null;
    }

    const data = (await response.json()) as GeocodingResponse;
    const top = data.features[0];
    if (!top) return null;

    const [lon, lat] = top.center;
    return { lat, lon, confidence: top.relevance };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.warn(`Mapbox Geocoding timed out after ${GEOCODE_TIMEOUT_MS}ms for "${placeName}" — leaving this chunk ungeocoded.`);
    } else {
      console.warn(`Mapbox Geocoding request failed for "${placeName}" — leaving this chunk ungeocoded.`, err);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parseFeatures(features: TilequeryFeature[]): MapboxPoi[] {
  return features
    .filter((f) => typeof f.properties.name === 'string' && f.properties.name.length > 0)
    .map((f) => ({
      name: f.properties.name as string,
      category: f.properties.class ?? null,
      distanceMeters: f.properties['tilequery.distance'] ?? 0,
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
    }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
}
