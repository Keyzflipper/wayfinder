import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleListFinds } from '../../src/routes/finds';
import { findOrCreateTrip } from '../../src/lib/trips';
import { applySchema } from '../helpers';

async function seedFind(
  tripId: string,
  overrides: Partial<{ name: string; photoKey: string; lat: number | null; lon: number | null; createdAt: string }> = {}
): Promise<string> {
  const id = crypto.randomUUID();
  const now = overrides.createdAt ?? new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO saved_finds (id, trip_id, photo_key, lat, lon, accuracy_m, name, detail, confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      tripId,
      overrides.photoKey ?? `${tripId}/${id}.jpg`,
      overrides.lat ?? null,
      overrides.lon ?? null,
      null,
      overrides.name ?? 'Test Find',
      'Some detail.',
      0.85,
      now,
      now
    )
    .run();
  return id;
}

function request(query: string): Request {
  return new Request(`https://worker.test/api/finds${query}`);
}

describe('handleListFinds', () => {
  beforeAll(async () => {
    await applySchema();
  });

  it('400s when tripId is missing', async () => {
    const response = await handleListFinds(request(''), env);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'missing_trip_id' });
  });

  it('returns an empty array for a trip with no finds', async () => {
    const tripId = await findOrCreateTrip(env, 'finds-empty-trip');
    const response = await handleListFinds(request(`?tripId=${tripId}`), env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { finds: unknown[] };
    expect(body.finds).toEqual([]);
  });

  it('returns finds most-recent-first with a photoUrl built from the photo key', async () => {
    const tripId = await findOrCreateTrip(env, 'finds-order-trip');
    await seedFind(tripId, { name: 'Older Find', createdAt: '2026-01-01T00:00:00.000Z', photoKey: `${tripId}/older.jpg` });
    await seedFind(tripId, { name: 'Newer Find', createdAt: '2026-01-02T00:00:00.000Z', photoKey: `${tripId}/newer.jpg` });

    const response = await handleListFinds(request(`?tripId=${tripId}`), env);
    const body = (await response.json()) as { finds: Array<{ name: string; photoUrl: string }> };

    expect(body.finds.map((f) => f.name)).toEqual(['Newer Find', 'Older Find']);
    expect(body.finds[0]?.photoUrl).toBe(`/api/photos?key=${encodeURIComponent(`${tripId}/newer.jpg`)}`);
  });

  it("does not leak another trip's finds", async () => {
    const tripA = await findOrCreateTrip(env, 'finds-scope-a');
    const tripB = await findOrCreateTrip(env, 'finds-scope-b');
    await seedFind(tripB, { name: 'Belongs to B' });

    const response = await handleListFinds(request(`?tripId=${tripA}`), env);
    const body = (await response.json()) as { finds: unknown[] };
    expect(body.finds).toEqual([]);
  });

  it('returns null fields as null rather than dropping them', async () => {
    const tripId = await findOrCreateTrip(env, 'finds-nulls-trip');
    await seedFind(tripId, { lat: null, lon: null });

    const response = await handleListFinds(request(`?tripId=${tripId}`), env);
    const body = (await response.json()) as { finds: Array<{ lat: number | null; lon: number | null }> };
    expect(body.finds[0]?.lat).toBeNull();
    expect(body.finds[0]?.lon).toBeNull();
  });
});
