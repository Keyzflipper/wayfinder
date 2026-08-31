import { env, fetchMock } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { handleRestaurants } from '../../src/routes/restaurants';

const LAT = 40.7128;
const LON = -74.006;
const NEARBY_SEARCH_PATH = '/maps/api/place/nearbysearch/json';

function request(query: string): Request {
  return new Request(`https://worker.test/api/restaurants${query}`);
}

describe('handleRestaurants', () => {
  it('400s when lat/lon are missing', async () => {
    const response = await handleRestaurants(request(''), env);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'invalid_coords' });
  });

  it('400s when lat is out of range', async () => {
    const response = await handleRestaurants(request('?lat=91&lon=0'), env);
    expect(response.status).toBe(400);
  });

  it('400s when radius exceeds the max', async () => {
    const response = await handleRestaurants(request(`?lat=${LAT}&lon=${LON}&radius=99999`), env);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'invalid_radius' });
  });

  it('400s when limit exceeds the max', async () => {
    const response = await handleRestaurants(request(`?lat=${LAT}&lon=${LON}&limit=999`), env);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'invalid_limit' });
  });

  it('returns formatted restaurants on success, converting price_level to a $ string', async () => {
    fetchMock
      .get('https://maps.googleapis.com')
      .intercept({ method: 'GET', path: (p) => p.startsWith(NEARBY_SEARCH_PATH) })
      .reply(200, {
        status: 'OK',
        results: [
          {
            place_id: 'abc',
            name: 'Great Bistro',
            rating: 4.7,
            user_ratings_total: 300,
            price_level: 2,
            vicinity: '123 Main St',
            opening_hours: { open_now: true },
            geometry: { location: { lat: LAT, lng: LON } },
          },
        ],
      });

    const response = await handleRestaurants(request(`?lat=${LAT}&lon=${LON}`), env);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { restaurants: unknown[] };
    expect(body.restaurants).toEqual([
      {
        name: 'Great Bistro',
        rating: 4.7,
        userRatingsTotal: 300,
        priceLevel: '$$',
        address: '123 Main St',
        distance: '0m',
        openNow: true,
      },
    ]);
  });

  it('returns null priceLevel when Google does not report one', async () => {
    fetchMock
      .get('https://maps.googleapis.com')
      .intercept({ method: 'GET', path: (p) => p.startsWith(NEARBY_SEARCH_PATH) })
      .reply(200, {
        status: 'OK',
        results: [
          {
            place_id: 'abc',
            name: 'No Price Data',
            rating: 4.2,
            user_ratings_total: 50,
            geometry: { location: { lat: LAT, lng: LON } },
          },
        ],
      });

    const response = await handleRestaurants(request(`?lat=${LAT}&lon=${LON}`), env);
    const body = (await response.json()) as { restaurants: Array<{ priceLevel: string | null }> };
    expect(body.restaurants[0]?.priceLevel).toBeNull();
  });

  it('passes custom radius and limit through to the Google Places request', async () => {
    fetchMock
      .get('https://maps.googleapis.com')
      .intercept({
        method: 'GET',
        path: (p) => p.startsWith(NEARBY_SEARCH_PATH) && p.includes('radius=200'),
      })
      .reply(200, { status: 'OK', results: [] });

    const response = await handleRestaurants(request(`?lat=${LAT}&lon=${LON}&radius=200&limit=3`), env);
    expect(response.status).toBe(200);
  });
});
