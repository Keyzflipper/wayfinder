import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { handleGetPhoto } from '../../src/routes/photo';

function request(query: string): Request {
  return new Request(`https://worker.test/api/photos${query}`);
}

describe('handleGetPhoto', () => {
  it('400s when key is missing', async () => {
    const response = await handleGetPhoto(request(''), env);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'missing_key' });
  });

  it('404s when no object exists for the key', async () => {
    const response = await handleGetPhoto(request('?key=nonexistent/photo.jpg'), env);
    expect(response.status).toBe(404);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'photo_not_found' });
  });

  it('streams back the stored bytes with the stored content type', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await env.PHOTOS.put('trip-1/photo.jpg', bytes, { httpMetadata: { contentType: 'image/jpeg' } });

    const response = await handleGetPhoto(request('?key=trip-1%2Fphoto.jpg'), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('cache-control')).toContain('immutable');
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body).toEqual(bytes);
  });

  it('falls back to a generic content type when none was stored', async () => {
    await env.PHOTOS.put('trip-1/no-type.jpg', new Uint8Array([9]));

    const response = await handleGetPhoto(request('?key=trip-1%2Fno-type.jpg'), env);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    // Draining the body isn't the point of this test, but leaving it
    // undrained wedges isolated-storage teardown on Windows (EBUSY
    // unlinking the backing R2 sqlite file) — same fix as
    // test/routes/identify.test.ts uses.
    await response.arrayBuffer();
  });
});
