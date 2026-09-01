import { env, fetchMock } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleGuideUpload } from '../../src/routes/guide-upload';
import { applySchema } from '../helpers';

const GATEWAY_PATH = '/v1/test-account-id/test-gateway-id/anthropic/v1/messages';
const GEOCODE_PATH_PREFIX = '/geocoding/v5/mapbox.places/';

function mockExtraction(placeName: string | null, confidence: number) {
  fetchMock
    .get('https://gateway.ai.cloudflare.com')
    .intercept({ method: 'POST', path: GATEWAY_PATH })
    .reply(200, { content: [{ type: 'text', text: JSON.stringify({ placeName, confidence }) }] });
}

function mockGeocode(lat: number, lon: number, confidence: number) {
  fetchMock
    .get('https://api.mapbox.com')
    .intercept({ method: 'GET', path: (p) => p.startsWith(GEOCODE_PATH_PREFIX) })
    .reply(200, { type: 'FeatureCollection', features: [{ center: [lon, lat], relevance: confidence }] });
}

function postRequest(body: Record<string, unknown>): Request {
  return new Request('https://worker.test/api/guide', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Second paragraph padded so the two COMBINED exceed MAX_CHUNK_CHARS (1500,
// forcing a split into 2 chunks instead of 1) while staying under 1500 on
// its own (avoiding the hard-split-a-too-long-paragraph path, which would
// produce 3 chunks instead of 2). Short text under the limit on its own
// collapses into a single chunk — fine functionally, but these tests want
// to exercise the two-chunk case specifically.
const TWO_PARAGRAPH_TEXT =
  'Independence Hall is a historic building in Philadelphia, Pennsylvania, where the Declaration of Independence was signed.\n\n' +
  `General planning advice that does not name a specific place. ${'x'.repeat(1400)}`;

describe('handleGuideUpload', () => {
  beforeAll(async () => {
    await applySchema();
  });

  it('400s on a non-JSON body', async () => {
    const response = await handleGuideUpload(
      new Request('https://worker.test/api/guide', { method: 'POST', body: 'not json' }),
      env
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'invalid_json' });
  });

  it('400s when text is missing', async () => {
    const response = await handleGuideUpload(postRequest({ tripName: 'x' }), env);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'missing_text' });
  });

  it('400s when text is blank', async () => {
    const response = await handleGuideUpload(postRequest({ text: '   ', tripName: 'x' }), env);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'missing_text' });
  });

  it('413s when text exceeds the character limit', async () => {
    const response = await handleGuideUpload(postRequest({ text: 'a'.repeat(60001), tripName: 'x' }), env);
    expect(response.status).toBe(413);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'text_too_long' });
  });

  it('400s when tripName is missing', async () => {
    const response = await handleGuideUpload(postRequest({ text: 'some text' }), env);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'missing_trip_name' });
  });

  it('400s when tripName is blank', async () => {
    const response = await handleGuideUpload(postRequest({ text: 'some text', tripName: '   ' }), env);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'missing_trip_name' });
  });

  it('chunks pasted text by paragraph, geocodes the chunk that names a place', async () => {
    mockExtraction('Independence Hall, Philadelphia', 0.9);
    mockGeocode(39.9489, -75.1503, 0.87);
    mockExtraction(null, 0);

    const response = await handleGuideUpload(postRequest({ text: TWO_PARAGRAPH_TEXT, tripName: 'text-upload-trip' }), env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { tripId: string; chunksCreated: number; chunksGeocoded: number; truncated: boolean };
    expect(body.chunksCreated).toBe(2);
    expect(body.chunksGeocoded).toBe(1);
    expect(body.truncated).toBe(false);

    const rows = await env.DB.prepare('SELECT source_page, text, lat, lon, geocode_confidence FROM guide_chunks WHERE trip_id = ? ORDER BY source_page')
      .bind(body.tripId)
      .all<{ source_page: number; text: string; lat: number | null; lon: number | null; geocode_confidence: number | null }>();

    expect(rows.results).toHaveLength(2);
    expect(rows.results?.[0]?.text).toContain('Independence Hall');
    expect(rows.results?.[0]?.lat).toBeCloseTo(39.9489, 4);
    expect(rows.results?.[0]?.lon).toBeCloseTo(-75.1503, 4);
    expect(rows.results?.[0]?.geocode_confidence).toBeCloseTo(0.87, 4);

    expect(rows.results?.[1]?.text).toContain('General planning advice');
    expect(rows.results?.[1]?.lat).toBeNull();
    expect(rows.results?.[1]?.geocode_confidence).toBeNull();
  });

  it('skips geocoding entirely when extraction confidence is below the threshold', async () => {
    mockExtraction('Some Place', 0.2);
    mockExtraction('Another Place', 0.3);

    const response = await handleGuideUpload(postRequest({ text: TWO_PARAGRAPH_TEXT, tripName: 'low-confidence-trip' }), env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { chunksCreated: number; chunksGeocoded: number };
    expect(body.chunksCreated).toBe(2);
    expect(body.chunksGeocoded).toBe(0);
  });

  it('still creates ungeocoded chunks when Mapbox geocoding fails', async () => {
    mockExtraction('Independence Hall, Philadelphia', 0.9);
    fetchMock
      .get('https://api.mapbox.com')
      .intercept({ method: 'GET', path: (p) => p.startsWith(GEOCODE_PATH_PREFIX) })
      .reply(500, 'geocoding down');
    mockExtraction(null, 0);

    const response = await handleGuideUpload(postRequest({ text: TWO_PARAGRAPH_TEXT, tripName: 'geocode-fail-trip' }), env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { chunksCreated: number; chunksGeocoded: number };
    expect(body.chunksCreated).toBe(2);
    expect(body.chunksGeocoded).toBe(0);
  });

  it('reuses an existing trip by name rather than creating a duplicate', async () => {
    const existingId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare('INSERT INTO trips (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .bind(existingId, 'already-exists-trip', now, now)
      .run();

    mockExtraction(null, 0);

    const response = await handleGuideUpload(postRequest({ text: 'some notes with no place', tripName: 'already-exists-trip' }), env);
    const body = (await response.json()) as { tripId: string };

    expect(body.tripId).toBe(existingId);
    const count = await env.DB.prepare('SELECT COUNT(*) as n FROM trips WHERE name = ?').bind('already-exists-trip').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('replaces prior guide_chunks on re-upload instead of accumulating alongside them', async () => {
    mockExtraction('Independence Hall, Philadelphia', 0.9);
    mockGeocode(39.9489, -75.1503, 0.87);
    mockExtraction(null, 0);
    const first = await handleGuideUpload(postRequest({ text: TWO_PARAGRAPH_TEXT, tripName: 're-upload-trip' }), env);
    const firstBody = (await first.json()) as { tripId: string; chunksCreated: number };
    expect(firstBody.chunksCreated).toBe(2);

    mockExtraction('Independence Hall, Philadelphia', 0.9);
    mockGeocode(39.9489, -75.1503, 0.87);
    mockExtraction(null, 0);
    const second = await handleGuideUpload(postRequest({ text: TWO_PARAGRAPH_TEXT, tripName: 're-upload-trip' }), env);
    const secondBody = (await second.json()) as { tripId: string; chunksCreated: number };

    expect(secondBody.tripId).toBe(firstBody.tripId);
    expect(secondBody.chunksCreated).toBe(2);

    const count = await env.DB.prepare('SELECT COUNT(*) as n FROM guide_chunks WHERE trip_id = ?')
      .bind(firstBody.tripId)
      .first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it('truncates and geocodes only the first MAX_CHUNKS paragraphs when there are many', async () => {
    // Each paragraph padded to ~1500 chars (MAX_CHUNK_CHARS) so it forms its
    // own chunk on its own — short paragraphs would just get packed
    // together into far fewer chunks than paragraphs, never exceeding MAX_CHUNKS.
    const manyParagraphs = Array.from(
      { length: 25 },
      (_, i) => `Paragraph number ${i} with no specific place named. ${'x'.repeat(1450)}`
    ).join('\n\n');

    for (let i = 0; i < 20; i++) mockExtraction(null, 0);

    const response = await handleGuideUpload(postRequest({ text: manyParagraphs, tripName: 'many-paragraphs-trip' }), env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { chunksCreated: number; truncated: boolean };
    expect(body.chunksCreated).toBe(20);
    expect(body.truncated).toBe(true);
  });
});
