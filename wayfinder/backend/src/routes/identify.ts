// routes/identify.ts — POST /api/identify
//
// Flow: parse FormData -> Claude Vision (fail-loud, aborts early on failure)
// -> only on success: persist photo to R2 + saved_finds row to D1 -> Mapbox
// nearby lookup (degrade-gracefully) + guide-chunk proximity match -> respond.
//
// Deliberately does NOT touch R2/D1 before Claude Vision succeeds — a failed
// identification should leave no orphaned storage or half-written rows.

import type { Env, IdentifyResponse, NearbyPlace } from '../types';
import { identifyImage, ClaudeVisionError } from '../lib/claude';
import { fetchNearbyPois } from '../lib/mapbox';

const GUIDE_MATCH_RADIUS_METERS = 150; // tighter than the POI search radius — a guide excerpt should be about *this* spot, not the general area
const EARTH_RADIUS_METERS = 6371000;

export async function handleIdentify(request: Request, env: Env): Promise<Response> {
  // ---- Parse incoming form ----
  let form: FormData;
  try {
    form = await request.formData();
  } catch (err) {
    return jsonError(400, 'invalid_form', 'Could not parse multipart form data.');
  }

  const photo = form.get('photo');
  if (!(photo instanceof File) || photo.size === 0) {
    return jsonError(400, 'missing_photo', 'No photo was included in the request.');
  }

  const maxBytes = Number(env.MAX_PHOTO_UPLOAD_BYTES);
  if (photo.size > maxBytes) {
    return jsonError(413, 'photo_too_large', `Photo exceeds the ${maxBytes}-byte limit.`);
  }

  const tripName = typeof form.get('tripName') === 'string' ? (form.get('tripName') as string).trim() : '';
  const { lat, lon } = parseOptionalCoords(form);

  // ---- Claude Vision (fail-loud) ----
  const photoBytes = await photo.arrayBuffer();
  const mimeType = photo.type || 'image/jpeg';

  let identification;
  try {
    identification = await identifyImage(env, photoBytes, mimeType);
  } catch (err) {
    if (err instanceof ClaudeVisionError) {
      console.error('Claude Vision failed:', err.message, err.cause);
      return jsonError(502, 'vision_failed', "Couldn't identify the photo. Try again.");
    }
    throw err; // genuinely unexpected — let it surface as a 500
  }

  // ---- Only now: persist ----
  const tripId = tripName.length > 0 ? await findOrCreateTrip(env, tripName) : null;

  const findId = crypto.randomUUID();
  const photoKey = `${tripId ?? 'no-trip'}/${findId}.jpg`;
  await env.PHOTOS.put(photoKey, photoBytes, {
    httpMetadata: { contentType: mimeType },
  });

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO saved_finds (id, trip_id, photo_key, lat, lon, accuracy_m, name, detail, confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(findId, tripId, photoKey, lat, lon, null, identification.name, identification.detail, identification.confidence, now, now)
    .run();

  // ---- Enrichment: nearby POIs + guide excerpt (both optional, both skip cleanly if no coords) ----
  let nearby: NearbyPlace[] = [];
  let guideExcerpt: string | null = null;

  if (lat !== null && lon !== null) {
    const pois = await fetchNearbyPois(env, lat, lon);
    nearby = pois.map((poi) => ({
      name: poi.name,
      category: poi.category,
      distance: formatDistance(poi.distanceMeters),
    }));

    if (tripId !== null) {
      guideExcerpt = await findNearbyGuideExcerpt(env, tripId, lat, lon);
    }
  }

  const response: IdentifyResponse = {
    name: identification.name,
    detail: identification.detail,
    confidence: identification.confidence,
    guideExcerpt,
    nearby,
    cachedAt: now,
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// ---- Helpers ----

function parseOptionalCoords(form: FormData): { lat: number | null; lon: number | null } {
  const rawLat = form.get('lat');
  const rawLon = form.get('lon');
  if (typeof rawLat !== 'string' || typeof rawLon !== 'string') {
    return { lat: null, lon: null };
  }
  const lat = Number(rawLat);
  const lon = Number(rawLon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { lat: null, lon: null };
  }
  return { lat, lon };
}

async function findOrCreateTrip(env: Env, name: string): Promise<string> {
  const existing = await env.DB.prepare('SELECT id FROM trips WHERE name = ? LIMIT 1').bind(name).first<{ id: string }>();
  if (existing) return existing.id;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare('INSERT INTO trips (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .bind(id, name, now, now)
    .run();
  return id;
}

async function findNearbyGuideExcerpt(env: Env, tripId: string, lat: number, lon: number): Promise<string | null> {
  const latDelta = GUIDE_MATCH_RADIUS_METERS / 111320;
  const lonDelta = GUIDE_MATCH_RADIUS_METERS / (111320 * Math.cos((lat * Math.PI) / 180));

  const candidates = await env.DB.prepare(
    `SELECT text, lat, lon FROM guide_chunks
     WHERE trip_id = ? AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?
     LIMIT 20`
  )
    .bind(tripId, lat - latDelta, lat + latDelta, lon - lonDelta, lon + lonDelta)
    .all<{ text: string; lat: number; lon: number }>();

  if (!candidates.results || candidates.results.length === 0) return null;

  let nearest: { text: string; distance: number } | null = null;
  for (const row of candidates.results) {
    const distance = haversineMeters(lat, lon, row.lat, row.lon);
    if (distance <= GUIDE_MATCH_RADIUS_METERS && (nearest === null || distance < nearest.distance)) {
      nearest = { text: row.text, distance };
    }
  }

  return nearest?.text ?? null;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Presentation formatting lives at the route layer, not in mapbox.ts —
// same separation-of-concerns call we made for lib/mapbox.ts. This will
// likely move to a shared lib/format.ts once routes/nearby.ts needs it too.
function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)}m`;
  return `${(meters / 1000).toFixed(1)}km`;
}

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
