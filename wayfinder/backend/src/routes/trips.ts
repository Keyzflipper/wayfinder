// routes/trips.ts — GET /api/trips
//
// Lists every trip, most recently active first, with a find count so the
// client can show something meaningful without a second round trip per row.

import type { Env, TripSummary } from '../types';

const MAX_TRIPS = 100;

export async function handleListTrips(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT t.id, t.name, t.created_at, t.updated_at, COUNT(sf.id) as find_count
     FROM trips t
     LEFT JOIN saved_finds sf ON sf.trip_id = t.id
     GROUP BY t.id
     ORDER BY t.updated_at DESC
     LIMIT ?`
  )
    .bind(MAX_TRIPS)
    .all<{ id: string; name: string; created_at: string; updated_at: string; find_count: number }>();

  const trips: TripSummary[] = (rows.results ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    findCount: row.find_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  return new Response(JSON.stringify({ trips }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
