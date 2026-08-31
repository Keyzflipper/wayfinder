import { env, fetchMock } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { identifyImage, ClaudeVisionError } from '../../src/lib/claude';

// Matches the gateway URL built in lib/claude.ts from the test bindings
// set in vitest.config.ts (CLOUDFLARE_ACCOUNT_ID / AI_GATEWAY_ID).
const GATEWAY_PATH = '/v1/test-account-id/test-gateway-id/anthropic/v1/messages';

function mockGatewayReply(body: unknown, status = 200) {
  fetchMock
    .get('https://gateway.ai.cloudflare.com')
    .intercept({ method: 'POST', path: GATEWAY_PATH })
    .reply(status, body as never, { headers: { 'content-type': 'application/json' } });
}

// Built via a plain ArrayBuffer + view, not TextEncoder().encode().buffer —
// newer TS libs type TypedArray as generic over ArrayBufferLike (which
// includes SharedArrayBuffer), so `.buffer` there isn't assignable to the
// plain `ArrayBuffer` identifyImage() expects.
const photoBytes = new ArrayBuffer(4);
new Uint8Array(photoBytes).set([1, 2, 3, 4]);

describe('identifyImage', () => {
  it('parses a well-formed identification', async () => {
    mockGatewayReply({
      content: [{ type: 'text', text: JSON.stringify({ name: 'Eiffel Tower', detail: 'A landmark.', confidence: 0.95 }) }],
    });

    const result = await identifyImage(env, photoBytes, 'image/jpeg');

    expect(result).toEqual({ name: 'Eiffel Tower', detail: 'A landmark.', confidence: 0.95 });
  });

  it('strips markdown code fences before parsing', async () => {
    mockGatewayReply({
      content: [
        { type: 'text', text: '```json\n' + JSON.stringify({ name: 'Big Ben', detail: 'A clock tower.', confidence: 0.8 }) + '\n```' },
      ],
    });

    const result = await identifyImage(env, photoBytes, 'image/jpeg');

    expect(result.name).toBe('Big Ben');
  });

  it('throws ClaudeVisionError on a non-OK gateway response', async () => {
    mockGatewayReply('upstream exploded', 502);

    await expect(identifyImage(env, photoBytes, 'image/jpeg')).rejects.toThrow(ClaudeVisionError);
  });

  it('throws ClaudeVisionError when the response body is not valid JSON', async () => {
    fetchMock
      .get('https://gateway.ai.cloudflare.com')
      .intercept({ method: 'POST', path: GATEWAY_PATH })
      .reply(200, 'not json at all');

    await expect(identifyImage(env, photoBytes, 'image/jpeg')).rejects.toThrow(ClaudeVisionError);
  });

  it('throws ClaudeVisionError when there is no text content block', async () => {
    mockGatewayReply({ content: [{ type: 'image' }] });

    await expect(identifyImage(env, photoBytes, 'image/jpeg')).rejects.toThrow(/no text content block/);
  });

  it('throws ClaudeVisionError when a required field is missing', async () => {
    mockGatewayReply({ content: [{ type: 'text', text: JSON.stringify({ name: 'Big Ben', confidence: 0.8 }) }] });

    await expect(identifyImage(env, photoBytes, 'image/jpeg')).rejects.toThrow(/missing required fields/);
  });

  it('throws ClaudeVisionError when confidence is out of range', async () => {
    mockGatewayReply({
      content: [{ type: 'text', text: JSON.stringify({ name: 'Big Ben', detail: 'x', confidence: 1.5 }) }],
    });

    await expect(identifyImage(env, photoBytes, 'image/jpeg')).rejects.toThrow(/out-of-range confidence/);
  });
});
