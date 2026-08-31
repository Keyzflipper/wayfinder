import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Worker routing', () => {
  it('GET /api/health returns ok with the environment', async () => {
    const response = await SELF.fetch('https://worker.test/api/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok' });
  });

  it('OPTIONS preflight returns 204 with CORS headers', async () => {
    const response = await SELF.fetch('https://worker.test/api/identify', { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });

  it('unknown routes 404 with a CORS header attached', async () => {
    const response = await SELF.fetch('https://worker.test/api/does-not-exist');
    expect(response.status).toBe(404);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  it('GET /api/nearby without coords 400s (route is wired up)', async () => {
    const response = await SELF.fetch('https://worker.test/api/nearby');
    expect(response.status).toBe(400);
  });

  it('wrong method on a known path 404s rather than 405ing', async () => {
    const response = await SELF.fetch('https://worker.test/api/identify', { method: 'GET' });
    expect(response.status).toBe(404);
  });
});
