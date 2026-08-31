import { env, fetchMock } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { handleNearby } from '../../src/routes/nearby';

const LAT = 40.7128;
const LON = -74.006;
const TILEQUERY_PATH = `/v4/mapbox.mapbox-streets-v8/tilequery/${LON},${LAT}.json`;

function request(query: string): Request {
  return new Request(`https://worker.test/api/nearby${query}`);
}

describe('handleNearby', () => {
  it('400s when lat/lon are missing', async () => {
    const response = await handleNearby(request(''), env);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'invalid_coords' });
  });

  it('400s when lat/lon are not finite numbers', async () => {
    const response = await handleNearby(request('?lat=abc&lon=-74'), env);
    expect(response.status).toBe(400);
  });

  it('400s on an empty-string lat instead of silently treating it as 0', async () => {
    const response = await handleNearby(request('?lat=&lon=-74.006'), env);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'invalid_coords' });
  });

  it('400s when lat is out of range', async () => {
    const response = await handleNearby(request('?lat=91&lon=0'), env);
    expect(response.status).toBe(400);
  });

  it('400s when lon is out of range', async () => {
    const response = await handleNearby(request('?lat=0&lon=181'), env);
    expect(response.status).toBe(400);
  });

  it('400s when radius is not a positive integer within bounds', async () => {
    const response = await handleNearby(request(`?lat=${LAT}&lon=${LON}&radius=0`), env);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'invalid_radius' });
  });

  it('400s when limit exceeds the max', async () => {
    const response = await handleNearby(request(`?lat=${LAT}&lon=${LON}&limit=999`), env);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'invalid_limit' });
  });

  it('returns formatted nearby places on success', async () => {
    fetchMock
      .get('https://api.mapbox.com')
      .intercept({ method: 'GET', path: (p) => p.startsWith(TILEQUERY_PATH) })
      .reply(200, {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { name: 'Battery Park', class: 'park', 'tilequery.distance': 1234 },
            geometry: { type: 'Point', coordinates: [LON, LAT] },
          },
        ],
      });

    const response = await handleNearby(request(`?lat=${LAT}&lon=${LON}`), env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { nearby: unknown[] };
    expect(body.nearby).toEqual([{ name: 'Battery Park', category: 'park', distance: '1.2km' }]);
  });

  it('passes custom radius and limit through to the Mapbox request', async () => {
    fetchMock
      .get('https://api.mapbox.com')
      .intercept({
        method: 'GET',
        path: (p) => p.startsWith(TILEQUERY_PATH) && p.includes('radius=100') && p.includes('limit=3'),
      })
      .reply(200, { type: 'FeatureCollection', features: [] });

    const response = await handleNearby(request(`?lat=${LAT}&lon=${LON}&radius=100&limit=3`), env);
    expect(response.status).toBe(200);
  });
});
