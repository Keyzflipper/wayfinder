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
import { formatDistance } from '../lib/format';
import { findOrCreateTrip } from '../lib/trips';
import { findNearbyGuideChunks } from '../lib/guideChunks';

const GUIDE_MATCH_RADIUS_METERS = 150; // tighter than the POI search radius — a guide excerpt should be about *this* spot, not the general area

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
      const [nearest] = await findNearbyGuideChunks(env, tripId, lat, lon, { radiusMeters: GUIDE_MATCH_RADIUS_METERS, limit: 1 });
      guideExcerpt = nearest?.text ?? null;
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

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
