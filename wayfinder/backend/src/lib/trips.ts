// lib/trips.ts — trip lookup/creation, shared across routes.
// Split out of routes/identify.ts once routes/guide-upload.ts needed the
// same find-or-create-by-name logic for attaching an uploaded guide to a trip.

import type { Env } from '../types';

// Atomic upsert on name (relies on schema.sql's UNIQUE index on trips.name)
// rather than a SELECT-then-branch — the latter has a real race window on
// Workers, which can run concurrent requests against the same isolate: two
// near-simultaneous calls for the same brand-new name could both pass a
// SELECT before either INSERT commits, creating two trip rows with the same
// name. ON CONFLICT DO UPDATE also means every call — not just creation —
// bumps updated_at, which is what makes routes/trips.ts's "most recently
// active first" ordering correct for reused trips, not just new ones.
export async function findOrCreateTrip(env: Env, name: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO trips (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET updated_at = excluded.updated_at
     RETURNING id`
  )
    .bind(id, name, now, now)
    .first<{ id: string }>();
  return row!.id;
}
