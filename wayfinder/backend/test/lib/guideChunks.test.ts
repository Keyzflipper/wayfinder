import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { findNearbyGuideChunks } from '../../src/lib/guideChunks';
import { applySchema } from '../helpers';

const LAT = 40.6892;
const LON = -74.0445;

async function seedTrip(name: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare('INSERT INTO trips (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').bind(id, name, now, now).run();
  return id;
}

async function seedChunk(tripId: string, text: string, lat: number | null, lon: number | null): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO guide_chunks (id, trip_id, source_page, text, lat, lon, geocode_confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(crypto.randomUUID(), tripId, 1, text, lat, lon, lat === null ? null : 0.9, new Date().toISOString())
    .run();
}

describe('findNearbyGuideChunks', () => {
  beforeAll(async () => {
    await applySchema();
  });

  it('returns chunks within radius sorted by distance, nearest first', async () => {
    const tripId = await seedTrip('geo-trip-1');
    await seedChunk(tripId, 'Far chunk', LAT + 0.01, LON); // ~1.1km away
    await seedChunk(tripId, 'Near chunk', LAT + 0.0005, LON); // ~55m away

    const results = await findNearbyGuideChunks(env, tripId, LAT, LON, { radiusMeters: 200 });

    expect(results).toHaveLength(1);
    expect(results[0]?.text).toBe('Near chunk');
  });

  it('excludes chunks outside the radius even if they matched the bounding-box prefilter', async () => {
    const tripId = await seedTrip('geo-trip-2');
    // Same lat, far enough in longitude to pass a loose box filter but fail the exact circular distance check.
    await seedChunk(tripId, 'Corner chunk', LAT, LON + 0.01);

    const results = await findNearbyGuideChunks(env, tripId, LAT, LON, { radiusMeters: 300 });

    expect(results).toEqual([]);
  });

  it('ignores chunks with no coordinates (never geocoded)', async () => {
    const tripId = await seedTrip('geo-trip-3');
    await seedChunk(tripId, 'Ungeocoded chunk', null, null);
    await seedChunk(tripId, 'Geocoded chunk', LAT, LON);

    const results = await findNearbyGuideChunks(env, tripId, LAT, LON, { radiusMeters: 100 });

    expect(results.map((r) => r.text)).toEqual(['Geocoded chunk']);
  });

  it('scopes results to the given trip only', async () => {
    const tripA = await seedTrip('geo-trip-4a');
    const tripB = await seedTrip('geo-trip-4b');
    await seedChunk(tripA, 'Trip A chunk', LAT, LON);
    await seedChunk(tripB, 'Trip B chunk', LAT, LON);

    const results = await findNearbyGuideChunks(env, tripA, LAT, LON, { radiusMeters: 100 });

    expect(results.map((r) => r.text)).toEqual(['Trip A chunk']);
  });

  it('respects the limit option', async () => {
    const tripId = await seedTrip('geo-trip-5');
    for (let i = 0; i < 5; i++) {
      await seedChunk(tripId, `Chunk ${i}`, LAT + i * 0.0001, LON);
    }

    const results = await findNearbyGuideChunks(env, tripId, LAT, LON, { radiusMeters: 200, limit: 2 });

    expect(results).toHaveLength(2);
  });

  it('returns [] when no chunks exist for the trip', async () => {
    const tripId = await seedTrip('geo-trip-6');
    const results = await findNearbyGuideChunks(env, tripId, LAT, LON, { radiusMeters: 200 });
    expect(results).toEqual([]);
  });
});
