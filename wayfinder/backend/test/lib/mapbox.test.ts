import { env, fetchMock } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { fetchNearbyPois } from '../../src/lib/mapbox';

const LAT = 40.7128;
const LON = -74.006;
const TILEQUERY_PATH = `/v4/mapbox.mapbox-streets-v8/tilequery/${LON},${LAT}.json`;

describe('fetchNearbyPois', () => {
  it('parses, filters unnamed features, and sorts by distance', async () => {
    fetchMock
      .get('https://api.mapbox.com')
      .intercept({ method: 'GET', path: (p) => p.startsWith(TILEQUERY_PATH) })
      .reply(
        200,
        {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: { name: 'Far Cafe', class: 'food', 'tilequery.distance': 400 },
              geometry: { type: 'Point', coordinates: [LON, LAT] },
            },
            {
              type: 'Feature',
              properties: { class: 'landmark', 'tilequery.distance': 10 }, // no name — must be dropped
              geometry: { type: 'Point', coordinates: [LON, LAT] },
            },
            {
              type: 'Feature',
              properties: { name: 'Near Park', class: 'park', 'tilequery.distance': 50 },
              geometry: { type: 'Point', coordinates: [LON, LAT] },
            },
          ],
        },
        { headers: { 'content-type': 'application/json' } }
      );

    const pois = await fetchNearbyPois(env, LAT, LON);

    expect(pois).toEqual([
      { name: 'Near Park', category: 'park', distanceMeters: 50, lat: LAT, lon: LON },
      { name: 'Far Cafe', category: 'food', distanceMeters: 400, lat: LAT, lon: LON },
    ]);
  });

  it('returns [] on a 429 rate-limit response instead of throwing', async () => {
    fetchMock
      .get('https://api.mapbox.com')
      .intercept({ method: 'GET', path: (p) => p.startsWith(TILEQUERY_PATH) })
      .reply(429, 'rate limited');

    await expect(fetchNearbyPois(env, LAT, LON)).resolves.toEqual([]);
  });

  it('returns [] on a non-OK response instead of throwing', async () => {
    fetchMock
      .get('https://api.mapbox.com')
      .intercept({ method: 'GET', path: (p) => p.startsWith(TILEQUERY_PATH) })
      .reply(500, 'server error');

    await expect(fetchNearbyPois(env, LAT, LON)).resolves.toEqual([]);
  });

  it('sends the access token, radius, and limit as query params', async () => {
    fetchMock
      .get('https://api.mapbox.com')
      .intercept({
        method: 'GET',
        path: (p) =>
          p.startsWith(TILEQUERY_PATH) &&
          p.includes('radius=250') &&
          p.includes('limit=5') &&
          p.includes('access_token=test-mapbox-token'),
      })
      .reply(200, { type: 'FeatureCollection', features: [] });

    await fetchNearbyPois(env, LAT, LON, { radiusMeters: 250, limit: 5 });
  });
});
