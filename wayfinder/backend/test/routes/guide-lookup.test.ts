import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleGuideLookup } from '../../src/routes/guide-lookup';
import { applySchema } from '../helpers';

const LAT = 40.6892;
const LON = -74.0445;

async function seedTrip(name: string): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare('INSERT INTO trips (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').bind(id, name, now, now).run();
  return id;
}

async function seedChunk(tripId: string, text: string, sourcePage: number, lat: number, lon: number): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO guide_chunks (id, trip_id, source_page, text, lat, lon, geocode_confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
    .bind(crypto.randomUUID(), tripId, sourcePage, text, lat, lon, 0.9, new Date().toISOString())
    .run();
}

function request(query: string): Request {
  return new Request(`https://worker.test/api/guide/nearby${query}`);
}

describe('handleGuideLookup', () => {
  beforeAll(async () => {
    await applySchema();
  });

  it('400s when tripId is missing', async () => {
    const response = await handleGuideLookup(request(`?lat=${LAT}&lon=${LON}`), env);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'missing_trip_id' });
  });

  it('400s when lat/lon are missing', async () => {
    const response = await handleGuideLookup(request('?tripId=abc'), env);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'invalid_coords' });
  });

  it('400s when lat is out of range', async () => {
    const response = await handleGuideLookup(request('?tripId=abc&lat=91&lon=0'), env);
    expect(response.status).toBe(400);
  });

  it('400s when radius exceeds the max', async () => {
    const response = await handleGuideLookup(request(`?tripId=abc&lat=${LAT}&lon=${LON}&radius=99999`), env);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'invalid_radius' });
  });

  it('returns formatted, distance-sorted chunks for the given trip', async () => {
    const tripId = await seedTrip('lookup-trip-1');
    await seedChunk(tripId, 'Far excerpt', 3, LAT + 0.002, LON); // ~220m
    await seedChunk(tripId, 'Near excerpt', 1, LAT + 0.0003, LON); // ~33m

    const response = await handleGuideLookup(request(`?tripId=${tripId}&lat=${LAT}&lon=${LON}&radius=300`), env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { chunks: Array<{ text: string; sourcePage: number; distance: string }> };
    expect(body.chunks.map((c) => c.text)).toEqual(['Near excerpt', 'Far excerpt']);
    expect(body.chunks[0]?.sourcePage).toBe(1);
    expect(body.chunks[0]?.distance).toMatch(/^\d+m$/);
  });

  it('returns an empty array when nothing is within radius', async () => {
    const tripId = await seedTrip('lookup-trip-2');
    const response = await handleGuideLookup(request(`?tripId=${tripId}&lat=${LAT}&lon=${LON}`), env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { chunks: unknown[] };
    expect(body.chunks).toEqual([]);
  });

  it("does not leak another trip's chunks into the results", async () => {
    const tripA = await seedTrip('lookup-trip-3a');
    const tripB = await seedTrip('lookup-trip-3b');
    await seedChunk(tripB, 'Belongs to trip B', 1, LAT, LON);

    const response = await handleGuideLookup(request(`?tripId=${tripA}&lat=${LAT}&lon=${LON}`), env);
    const body = (await response.json()) as { chunks: unknown[] };
    expect(body.chunks).toEqual([]);
  });
});
