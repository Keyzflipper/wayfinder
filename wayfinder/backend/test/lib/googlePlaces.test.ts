import { env, fetchMock } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { fetchNearbyRestaurants } from '../../src/lib/googlePlaces';

const LAT = 40.7128;
const LON = -74.006;
const NEARBY_SEARCH_PATH = '/maps/api/place/nearbysearch/json';

function mockPlaces(status: string, results: unknown[] = []) {
  fetchMock
    .get('https://maps.googleapis.com')
    .intercept({ method: 'GET', path: (p) => p.startsWith(NEARBY_SEARCH_PATH) })
    .reply(200, { status, results });
}

describe('fetchNearbyRestaurants', () => {
  it('parses, filters, and sorts by rating then review count', async () => {
    mockPlaces('OK', [
      {
        place_id: 'low-rated',
        name: 'Meh Diner',
        rating: 3.5,
        user_ratings_total: 200,
        geometry: { location: { lat: LAT, lng: LON } },
      },
      {
        place_id: 'top-rated-fewer-reviews',
        name: 'Great Bistro',
        rating: 4.8,
        user_ratings_total: 50,
        price_level: 3,
        vicinity: '123 Main St',
        opening_hours: { open_now: true },
        geometry: { location: { lat: LAT, lng: LON } },
      },
      {
        place_id: 'same-rating-more-reviews',
        name: 'Popular Bistro',
        rating: 4.8,
        user_ratings_total: 900,
        geometry: { location: { lat: LAT, lng: LON } },
      },
    ]);

    const restaurants = await fetchNearbyRestaurants(env, LAT, LON);

    expect(restaurants.map((r) => r.name)).toEqual(['Popular Bistro', 'Great Bistro', 'Meh Diner']);
    expect(restaurants[1]).toMatchObject({
      name: 'Great Bistro',
      rating: 4.8,
      userRatingsTotal: 50,
      priceLevel: 3,
      address: '123 Main St',
      openNow: true,
      distanceMeters: 0,
    });
  });

  it('excludes results with no rating', async () => {
    mockPlaces('OK', [
      { place_id: 'unrated', name: 'New Place', geometry: { location: { lat: LAT, lng: LON } } },
    ]);

    await expect(fetchNearbyRestaurants(env, LAT, LON)).resolves.toEqual([]);
  });

  it('excludes results below the minimum review count', async () => {
    mockPlaces('OK', [
      {
        place_id: 'barely-reviewed',
        name: 'Unproven 5-Star',
        rating: 5.0,
        user_ratings_total: 1,
        geometry: { location: { lat: LAT, lng: LON } },
      },
    ]);

    await expect(fetchNearbyRestaurants(env, LAT, LON)).resolves.toEqual([]);
  });

  it('excludes permanently and temporarily closed businesses', async () => {
    mockPlaces('OK', [
      {
        place_id: 'closed-forever',
        name: 'Gone',
        rating: 4.9,
        user_ratings_total: 500,
        business_status: 'CLOSED_PERMANENTLY',
        geometry: { location: { lat: LAT, lng: LON } },
      },
      {
        place_id: 'closed-for-now',
        name: 'On Hiatus',
        rating: 4.9,
        user_ratings_total: 500,
        business_status: 'CLOSED_TEMPORARILY',
        geometry: { location: { lat: LAT, lng: LON } },
      },
    ]);

    await expect(fetchNearbyRestaurants(env, LAT, LON)).resolves.toEqual([]);
  });

  it('returns [] on ZERO_RESULTS without warning as an error case', async () => {
    mockPlaces('ZERO_RESULTS', []);

    await expect(fetchNearbyRestaurants(env, LAT, LON)).resolves.toEqual([]);
  });

  it('returns [] instead of throwing on a non-OK API status', async () => {
    mockPlaces('REQUEST_DENIED', []);

    await expect(fetchNearbyRestaurants(env, LAT, LON)).resolves.toEqual([]);
  });

  it('returns [] instead of throwing on a non-OK HTTP response', async () => {
    fetchMock
      .get('https://maps.googleapis.com')
      .intercept({ method: 'GET', path: (p) => p.startsWith(NEARBY_SEARCH_PATH) })
      .reply(500, 'server error');

    await expect(fetchNearbyRestaurants(env, LAT, LON)).resolves.toEqual([]);
  });

  it('sends the api key, location, radius, and restaurant type as query params', async () => {
    fetchMock
      .get('https://maps.googleapis.com')
      .intercept({
        method: 'GET',
        path: (p) =>
          p.startsWith(NEARBY_SEARCH_PATH) &&
          p.includes(`location=${LAT}%2C${LON}`) &&
          p.includes('radius=250') &&
          p.includes('type=restaurant') &&
          p.includes('key=test-google-places-key'),
      })
      .reply(200, { status: 'OK', results: [] });

    await fetchNearbyRestaurants(env, LAT, LON, { radiusMeters: 250 });
  });

  it('respects the limit option after sorting', async () => {
    mockPlaces(
      'OK',
      Array.from({ length: 5 }, (_, i) => ({
        place_id: `place-${i}`,
        name: `Place ${i}`,
        rating: 4.0 + i * 0.1,
        user_ratings_total: 20,
        geometry: { location: { lat: LAT, lng: LON } },
      }))
    );

    const restaurants = await fetchNearbyRestaurants(env, LAT, LON, { limit: 2 });

    expect(restaurants).toHaveLength(2);
    expect(restaurants.map((r) => r.name)).toEqual(['Place 4', 'Place 3']);
  });
});
