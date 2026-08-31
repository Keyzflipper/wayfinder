// lib/trips.ts — trip lookup/creation, shared across routes.
// Split out of routes/identify.ts once routes/guide-upload.ts needed the
// same find-or-create-by-name logic for attaching an uploaded guide to a trip.

import type { Env } from '../types';

// Touches `updated_at` on every call, not just creation — routes/trips.ts
// orders the trip list by it to mean "most recently active", which is only
// true if using an existing trip bumps it the same way creating one does.
export async function findOrCreateTrip(env: Env, name: string): Promise<string> {
  const existing = await env.DB.prepare('SELECT id FROM trips WHERE name = ? LIMIT 1').bind(name).first<{ id: string }>();
  if (existing) {
    await env.DB.prepare('UPDATE trips SET updated_at = ? WHERE id = ?').bind(new Date().toISOString(), existing.id).run();
    return existing.id;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare('INSERT INTO trips (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .bind(id, name, now, now)
    .run();
  return id;
}
