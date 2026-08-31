import { env, fetchMock } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleIdentify } from '../../src/routes/identify';
import { applySchema } from '../helpers';

const GATEWAY_PATH = '/v1/test-account-id/test-gateway-id/anthropic/v1/messages';

function mockClaudeSuccess(name = 'Statue of Liberty', detail = 'A colossal neoclassical sculpture.', confidence = 0.9) {
  fetchMock
    .get('https://gateway.ai.cloudflare.com')
    .intercept({ method: 'POST', path: GATEWAY_PATH })
    .reply(200, { content: [{ type: 'text', text: JSON.stringify({ name, detail, confidence }) }] });
}

function buildForm(opts: { withPhoto?: boolean; tripName?: string; lat?: string; lon?: string } = {}): FormData {
  const form = new FormData();
  if (opts.withPhoto !== false) {
    form.set('photo', new File([new Uint8Array([1, 2, 3, 4])], 'photo.jpg', { type: 'image/jpeg' }));
  }
  if (opts.tripName !== undefined) form.set('tripName', opts.tripName);
  if (opts.lat !== undefined) form.set('lat', opts.lat);
  if (opts.lon !== undefined) form.set('lon', opts.lon);
  return form;
}

function postRequest(form: FormData): Request {
  return new Request('https://worker.test/api/identify', { method: 'POST', body: form });
}

describe('handleIdentify', () => {
  beforeAll(async () => {
    await applySchema();
  });

  it('400s when no photo is included', async () => {
    const response = await handleIdentify(postRequest(buildForm({ withPhoto: false })), env);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'missing_photo' });
  });

  it('502s when Claude Vision fails, and does not write to D1 or R2', async () => {
    fetchMock
      .get('https://gateway.ai.cloudflare.com')
      .intercept({ method: 'POST', path: GATEWAY_PATH })
      .reply(500, 'vision service down');

    const countBefore = await env.DB.prepare('SELECT COUNT(*) as n FROM saved_finds').first<{ n: number }>();

    const response = await handleIdentify(postRequest(buildForm({ tripName: 'fail-trip' })), env);

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('vision_failed');

    const countAfter = await env.DB.prepare('SELECT COUNT(*) as n FROM saved_finds').first<{ n: number }>();
    expect(countAfter?.n).toBe(countBefore?.n);
  });

  it('identifies, persists to D1 and R2, and enriches with nearby POIs when coords are given', async () => {
    mockClaudeSuccess();
    fetchMock
      .get('https://api.mapbox.com')
      .intercept({ method: 'GET', path: (p) => p.startsWith('/v4/mapbox.mapbox-streets-v8/tilequery/') })
      .reply(200, {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { name: 'Liberty Island Ferry', class: 'ferry_terminal', 'tilequery.distance': 75 },
            geometry: { type: 'Point', coordinates: [-74.0445, 40.6892] },
          },
        ],
      });

    const response = await handleIdentify(
      postRequest(buildForm({ tripName: 'nyc-trip', lat: '40.6892', lon: '-74.0445' })),
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      name: string;
      confidence: number;
      nearby: Array<{ name: string; distance: string }>;
      guideExcerpt: string | null;
      tripId: string | null;
    };
    expect(body.name).toBe('Statue of Liberty');
    expect(body.confidence).toBe(0.9);
    expect(body.nearby).toEqual([{ name: 'Liberty Island Ferry', category: 'ferry_terminal', distance: '75m' }]);
    expect(body.guideExcerpt).toBeNull();

    const trip = await env.DB.prepare('SELECT id FROM trips WHERE name = ?').bind('nyc-trip').first<{ id: string }>();
    expect(trip).not.toBeNull();
    expect(body.tripId).toBe(trip!.id);

    const find = await env.DB.prepare('SELECT * FROM saved_finds WHERE trip_id = ?')
      .bind(trip!.id)
      .first<{ name: string; photo_key: string }>();
    expect(find?.name).toBe('Statue of Liberty');

    // head(), not get() — get() returns an open body stream, and leaving it
    // undrained wedges isolated-storage teardown on Windows (EBUSY unlinking
    // the backing sqlite file). head() confirms existence without a body.
    const stored = await env.PHOTOS.head(find!.photo_key);
    expect(stored).not.toBeNull();
  });

  it('returns a null tripId when no tripName is provided', async () => {
    mockClaudeSuccess('Mystery Statue', 'No trip attached.', 0.5);

    const response = await handleIdentify(postRequest(buildForm({})), env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { tripId: string | null };
    expect(body.tripId).toBeNull();
  });

  it('skips nearby enrichment entirely when no coordinates are provided', async () => {
    mockClaudeSuccess('Unknown Building', 'Could not identify precisely.', 0.2);

    const response = await handleIdentify(postRequest(buildForm({ tripName: 'no-coords-trip' })), env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { nearby: unknown[]; guideExcerpt: string | null };
    expect(body.nearby).toEqual([]);
    expect(body.guideExcerpt).toBeNull();
  });

  it('matches a nearby guide chunk within the match radius', async () => {
    mockClaudeSuccess('Cafe Terrace', 'A cafe near a known spot.', 0.7);
    fetchMock
      .get('https://api.mapbox.com')
      .intercept({ method: 'GET', path: (p) => p.startsWith('/v4/mapbox.mapbox-streets-v8/tilequery/') })
      .reply(200, { type: 'FeatureCollection', features: [] });

    const tripId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare('INSERT INTO trips (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .bind(tripId, 'guide-trip', now, now)
      .run();
    await env.DB.prepare(
      'INSERT INTO guide_chunks (id, trip_id, source_page, text, lat, lon, geocode_confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
      .bind(crypto.randomUUID(), tripId, 12, 'A quaint cafe famously painted by Van Gogh.', 43.6782, 4.6306, 0.9, now)
      .run();

    const response = await handleIdentify(
      postRequest(buildForm({ tripName: 'guide-trip', lat: '43.6782', lon: '4.6306' })),
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { guideExcerpt: string | null };
    expect(body.guideExcerpt).toBe('A quaint cafe famously painted by Van Gogh.');
  });
});
