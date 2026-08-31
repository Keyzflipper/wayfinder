// routes/finds.ts — GET /api/finds?tripId=...
//
// Lists every saved_finds row for a trip, most recent first, with a
// ready-to-use photoUrl instead of the raw R2 key — the client hits
// GET /api/photos?key=... to actually fetch the image (routes/photo.ts).

import type { Env, TripFindSummary } from '../types';

const MAX_FINDS = 200;

export async function handleListFinds(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const tripId = url.searchParams.get('tripId');
  if (tripId === null || tripId.trim().length === 0) {
    return jsonError(400, 'missing_trip_id', 'Query param "tripId" is required.');
  }

  const rows = await env.DB.prepare(
    `SELECT id, name, detail, confidence, photo_key, lat, lon, created_at
     FROM saved_finds
     WHERE trip_id = ?
     ORDER BY created_at DESC
     LIMIT ?`
  )
    .bind(tripId, MAX_FINDS)
    .all<{
      id: string;
      name: string | null;
      detail: string | null;
      confidence: number | null;
      photo_key: string;
      lat: number | null;
      lon: number | null;
      created_at: string;
    }>();

  const finds: TripFindSummary[] = (rows.results ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    detail: row.detail,
    confidence: row.confidence,
    photoUrl: `/api/photos?key=${encodeURIComponent(row.photo_key)}`,
    lat: row.lat,
    lon: row.lon,
    createdAt: row.created_at,
  }));

  return new Response(JSON.stringify({ finds }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
