import { env, fetchMock } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { handleDescribe } from '../../src/routes/describe';

const GATEWAY_PATH = '/v1/test-account-id/test-gateway-id/anthropic/v1/messages';

function mockDescription(text: string) {
  fetchMock
    .get('https://gateway.ai.cloudflare.com')
    .intercept({ method: 'POST', path: GATEWAY_PATH })
    .reply(200, { content: [{ type: 'text', text }] });
}

function request(query: string): Request {
  return new Request(`https://worker.test/api/describe${query}`);
}

describe('handleDescribe', () => {
  it('400s when name is missing', async () => {
    const response = await handleDescribe(request('?lat=40&lon=-75'), env);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'missing_name' });
  });

  it('400s when lat/lon are missing', async () => {
    const response = await handleDescribe(request('?name=Independence+Hall'), env);
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'invalid_coords' });
  });

  it('returns a description on success', async () => {
    mockDescription('A red-brick colonial building where the Declaration of Independence was signed.');

    const response = await handleDescribe(request('?name=Independence+Hall&lat=39.9489&lon=-75.1503'), env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { description: string | null };
    expect(body.description).toBe('A red-brick colonial building where the Declaration of Independence was signed.');
  });

  it('returns a null description rather than an error when nothing specific is found', async () => {
    mockDescription('NONE');

    const response = await handleDescribe(request('?name=Some+Alley&lat=0&lon=0'), env);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { description: string | null };
    expect(body.description).toBeNull();
  });
});
