import { env, fetchMock } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleGuideUpload } from '../../src/routes/guide-upload';
import { applySchema } from '../helpers';
// `?arraybuffer` isn't an actual Vite import suffix — it silently resolves
// to an empty string at runtime despite typechecking fine, which is exactly
// as dangerous as it sounds. Using the same `?raw` mechanism schema.sql
// already relies on instead: it gives a UTF-8-decoded string, which is only
// byte-faithful for content that's pure ASCII — true for this hand-built
// fixture (scripts/generate-test-pdf.mjs), NOT true for a real-world PDF
// with embedded binary image/font data. Don't reuse this pattern for a
// fixture that isn't ASCII-only.
import samplePdfText from '../fixtures/sample-guide.pdf?raw';
const samplePdfBuffer = Uint8Array.from(samplePdfText, (c) => c.charCodeAt(0));

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

function buildForm(opts: { withPdf?: boolean; tripName?: string } = {}): FormData {
  const form = new FormData();
  if (opts.withPdf !== false) {
    form.set('pdf', new File([samplePdfBuffer], 'guide.pdf', { type: 'application/pdf' }));
  }
  if (opts.tripName !== undefined) form.set('tripName', opts.tripName);
  return form;
}

function postRequest(form: FormData): Request {
  return new Request('https://worker.test/api/guide', { method: 'POST', body: form });
}

describe('handleGuideUpload', () => {
  beforeAll(async () => {
    await applySchema();
  });

  it('400s when no PDF is included', async () => {
    const response = await handleGuideUpload(postRequest(buildForm({ withPdf: false, tripName: 'x' })), env);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'missing_pdf' });
  });

  it('400s when tripName is missing', async () => {
    const response = await handleGuideUpload(postRequest(buildForm({ tripName: undefined })), env);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'missing_trip_name' });
  });

  it('400s when tripName is blank', async () => {
    const response = await handleGuideUpload(postRequest(buildForm({ tripName: '   ' })), env);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'missing_trip_name' });
  });

  it(
    'extracts text, geocodes the chunk that names a place, and persists a chunk for both pages',
    async () => {
      // Page 1 ("Independence Hall...") resolves to a place; page 2 ("Planning Your Trip...") doesn't.
      mockExtraction('Independence Hall, Philadelphia', 0.9);
      mockGeocode(39.9489, -75.1503, 0.87);
      mockExtraction(null, 0);

      const response = await handleGuideUpload(postRequest(buildForm({ tripName: 'guide-upload-trip' })), env);

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        tripId: string;
        totalPages: number;
        chunksCreated: number;
        chunksGeocoded: number;
        truncated: boolean;
      };
      expect(body.totalPages).toBe(2);
      expect(body.chunksCreated).toBe(2);
      expect(body.chunksGeocoded).toBe(1);
      expect(body.truncated).toBe(false);

      const rows = await env.DB.prepare('SELECT source_page, text, lat, lon, geocode_confidence FROM guide_chunks WHERE trip_id = ? ORDER BY source_page')
        .bind(body.tripId)
        .all<{ source_page: number; text: string; lat: number | null; lon: number | null; geocode_confidence: number | null }>();

      expect(rows.results).toHaveLength(2);
      expect(rows.results?.[0]?.source_page).toBe(1);
      expect(rows.results?.[0]?.text).toContain('Independence Hall');
      expect(rows.results?.[0]?.lat).toBeCloseTo(39.9489, 4);
      expect(rows.results?.[0]?.lon).toBeCloseTo(-75.1503, 4);
      expect(rows.results?.[0]?.geocode_confidence).toBeCloseTo(0.87, 4);

      expect(rows.results?.[1]?.source_page).toBe(2);
      expect(rows.results?.[1]?.text).toContain('Planning Your Trip');
      expect(rows.results?.[1]?.lat).toBeNull();
      expect(rows.results?.[1]?.geocode_confidence).toBeNull();
    }
  );

  it('stores the raw PDF in the GUIDES bucket', async () => {
    mockExtraction('Independence Hall, Philadelphia', 0.9);
    mockGeocode(39.9489, -75.1503, 0.87);
    mockExtraction(null, 0);

    const response = await handleGuideUpload(postRequest(buildForm({ tripName: 'guide-upload-r2-trip' })), env);
    const body = (await response.json()) as { tripId: string };

    const list = await env.GUIDES.list({ prefix: `${body.tripId}/` });
    expect(list.objects).toHaveLength(1);
    expect(list.objects[0]?.key).toMatch(/\.pdf$/);

    // Checking size/content here, not just that an object exists — pdf.js
    // transfers/detaches the ArrayBuffer it's given during parsing, which
    // silently produced a 0-byte R2 object until guide-upload.ts copied the
    // bytes with .slice(0) before handing them to getDocumentProxy(). A
    // length-only check on `list.objects` would never have caught that.
    const stored = await env.GUIDES.get(list.objects[0]!.key);
    expect(stored).not.toBeNull();
    const storedBytes = await stored!.arrayBuffer();
    expect(storedBytes.byteLength).toBe(samplePdfBuffer.byteLength);
    expect(new Uint8Array(storedBytes)).toEqual(samplePdfBuffer);
  });

  it('skips geocoding entirely when extraction confidence is below the threshold', async () => {
    // Both pages return a placeName, but at confidence below MIN_EXTRACTION_CONFIDENCE (0.5) —
    // no Mapbox call should be attempted for either, so no geocode mock is registered.
    mockExtraction('Some Place', 0.2);
    mockExtraction('Another Place', 0.3);

    const response = await handleGuideUpload(postRequest(buildForm({ tripName: 'low-confidence-trip' })), env);

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

    const response = await handleGuideUpload(postRequest(buildForm({ tripName: 'geocode-fail-trip' })), env);

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
    mockExtraction(null, 0);

    const response = await handleGuideUpload(postRequest(buildForm({ tripName: 'already-exists-trip' })), env);
    const body = (await response.json()) as { tripId: string };

    expect(body.tripId).toBe(existingId);
    const count = await env.DB.prepare('SELECT COUNT(*) as n FROM trips WHERE name = ?').bind('already-exists-trip').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});
