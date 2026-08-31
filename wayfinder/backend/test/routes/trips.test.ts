import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleListTrips } from '../../src/routes/trips';
import { findOrCreateTrip } from '../../src/lib/trips';
import { applySchema } from '../helpers';

async function seedFind(tripId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO saved_finds (id, trip_id, photo_key, lat, lon, accuracy_m, name, detail, confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(crypto.randomUUID(), tripId, `${tripId}/photo.jpg`, null, null, null, 'Test Find', 'detail', 0.9, now, now)
    .run();
}

describe('handleListTrips', () => {
  beforeAll(async () => {
    await applySchema();
  });

  it('returns an empty list when there are no trips', async () => {
    // Isolated storage resets to the post-beforeAll baseline (schema only,
    // no rows) between tests, so this is safe to assert exactly.
    const response = await handleListTrips(env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { trips: unknown[] };
    expect(body.trips).toEqual([]);
  });

  it('includes a correct findCount per trip', async () => {
    const tripId = await findOrCreateTrip(env, 'trips-list-test-1');
    await seedFind(tripId);
    await seedFind(tripId);

    const response = await handleListTrips(env);
    const body = (await response.json()) as { trips: Array<{ id: string; name: string; findCount: number }> };
    const trip = body.trips.find((t) => t.id === tripId);

    expect(trip).toBeDefined();
    expect(trip?.name).toBe('trips-list-test-1');
    expect(trip?.findCount).toBe(2);
  });

  it('gives a trip with no finds a findCount of 0, not null', async () => {
    const tripId = await findOrCreateTrip(env, 'trips-list-test-empty');

    const response = await handleListTrips(env);
    const body = (await response.json()) as { trips: Array<{ id: string; findCount: number }> };
    const trip = body.trips.find((t) => t.id === tripId);

    expect(trip?.findCount).toBe(0);
  });

  it('orders most recently active first, including trips reused (not just created) recently', async () => {
    const older = await findOrCreateTrip(env, 'trips-list-order-older');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const newer = await findOrCreateTrip(env, 'trips-list-order-newer');
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Reusing the older trip should bump it back above the newer one.
    await findOrCreateTrip(env, 'trips-list-order-older');

    const response = await handleListTrips(env);
    const body = (await response.json()) as { trips: Array<{ id: string }> };
    const ids = body.trips.map((t) => t.id);

    expect(ids.indexOf(older)).toBeLessThan(ids.indexOf(newer));
  });
});
