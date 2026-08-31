import { env, fetchMock } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
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

// A minimal, valid, two-chapter EPUB built directly with fflate — an EPUB is
// just a zip of XML/XHTML, so unlike the hand-built PDF fixture there's no
// need for a binary file on disk with exact byte offsets.
function buildTestEpub(): Uint8Array {
  const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

  const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Test Guide</dc:title></metadata>
  <manifest>
    <item id="chap1" href="chap1.xhtml" media-type="application/xhtml+xml"/>
    <item id="chap2" href="chap2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chap1"/>
    <itemref idref="chap2"/>
  </spine>
</package>`;

  const chap1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h1>Independence Hall</h1>
<p>Independence Hall is a historic building in Philadelphia, Pennsylvania.</p>
</body></html>`;

  const chap2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
<h1>Planning Your Trip</h1>
<p>Some general planning advice that doesn't name a specific place.</p>
</body></html>`;

  return zipSync({
    'META-INF/container.xml': strToU8(containerXml),
    'OEBPS/content.opf': strToU8(contentOpf),
    'OEBPS/chap1.xhtml': strToU8(chap1),
    'OEBPS/chap2.xhtml': strToU8(chap2),
  });
}

function buildForm(opts: { file?: File | false; tripName?: string } = {}): FormData {
  const form = new FormData();
  if (opts.file !== false) {
    form.set('file', opts.file ?? new File([samplePdfBuffer], 'guide.pdf', { type: 'application/pdf' }));
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

  it('400s when no file is included', async () => {
    const response = await handleGuideUpload(postRequest(buildForm({ file: false, tripName: 'x' })), env);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'missing_file' });
  });

  it('400s on an unsupported file type', async () => {
    const form = buildForm({
      file: new File(['just some text'], 'notes.txt', { type: 'text/plain' }),
      tripName: 'x',
    });
    const response = await handleGuideUpload(postRequest(form), env);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'unsupported_format' });
  });

  it('413s when the file exceeds MAX_GUIDE_UPLOAD_BYTES', async () => {
    const tinyLimitEnv = { ...env, MAX_GUIDE_UPLOAD_BYTES: '10' };
    const response = await handleGuideUpload(postRequest(buildForm({ tripName: 'x' })), tinyLimitEnv);
    expect(response.status).toBe(413);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'file_too_large' });
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
    'extracts text from a PDF, geocodes the chunk that names a place, and persists a chunk for both pages',
    async () => {
      // Page 1 ("Independence Hall...") resolves to a place; page 2 ("Planning Your Trip...") doesn't.
      mockExtraction('Independence Hall, Philadelphia', 0.9);
      mockGeocode(39.9489, -75.1503, 0.87);
      mockExtraction(null, 0);

      const response = await handleGuideUpload(postRequest(buildForm({ tripName: 'guide-upload-trip' })), env);

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        tripId: string;
        totalSections: number;
        chunksCreated: number;
        chunksGeocoded: number;
        truncated: boolean;
      };
      expect(body.totalSections).toBe(2);
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

  it('extracts text from an EPUB in spine order and strips HTML tags', async () => {
    mockExtraction('Independence Hall, Philadelphia', 0.9);
    mockGeocode(39.9489, -75.1503, 0.87);
    mockExtraction(null, 0);

    const epubFile = new File([buildTestEpub()], 'guide.epub', { type: 'application/epub+zip' });
    const response = await handleGuideUpload(postRequest(buildForm({ file: epubFile, tripName: 'epub-trip' })), env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { tripId: string; totalSections: number; chunksCreated: number };
    expect(body.totalSections).toBe(2);
    expect(body.chunksCreated).toBe(2);

    const rows = await env.DB.prepare('SELECT source_page, text FROM guide_chunks WHERE trip_id = ? ORDER BY source_page')
      .bind(body.tripId)
      .all<{ source_page: number; text: string }>();

    expect(rows.results?.[0]?.text).toContain('Independence Hall');
    expect(rows.results?.[0]?.text).not.toContain('<h1>');
    expect(rows.results?.[0]?.text).not.toContain('<p>');
    expect(rows.results?.[1]?.text).toContain('Planning Your Trip');
  });

  it('detects EPUB by filename when the browser sends no/generic content type', async () => {
    mockExtraction(null, 0);
    mockExtraction(null, 0);

    const epubFile = new File([buildTestEpub()], 'guide.epub', { type: '' });
    const response = await handleGuideUpload(postRequest(buildForm({ file: epubFile, tripName: 'epub-sniff-trip' })), env);

    expect(response.status).toBe(200);
  });

  it('stores the raw file in the GUIDES bucket with the right extension', async () => {
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

  it('replaces prior guide_chunks on re-upload instead of accumulating alongside them', async () => {
    // First upload for this trip.
    mockExtraction('Independence Hall, Philadelphia', 0.9);
    mockGeocode(39.9489, -75.1503, 0.87);
    mockExtraction(null, 0);
    const first = await handleGuideUpload(postRequest(buildForm({ tripName: 're-upload-trip' })), env);
    const firstBody = (await first.json()) as { tripId: string; chunksCreated: number };
    expect(firstBody.chunksCreated).toBe(2);

    // Re-upload the same PDF for the same trip.
    mockExtraction('Independence Hall, Philadelphia', 0.9);
    mockGeocode(39.9489, -75.1503, 0.87);
    mockExtraction(null, 0);
    const second = await handleGuideUpload(postRequest(buildForm({ tripName: 're-upload-trip' })), env);
    const secondBody = (await second.json()) as { tripId: string; chunksCreated: number };

    expect(secondBody.tripId).toBe(firstBody.tripId);
    expect(secondBody.chunksCreated).toBe(2);

    // Exactly the second upload's chunks should remain — not 4.
    const count = await env.DB.prepare('SELECT COUNT(*) as n FROM guide_chunks WHERE trip_id = ?')
      .bind(firstBody.tripId)
      .first<{ n: number }>();
    expect(count?.n).toBe(2);
  });
});
