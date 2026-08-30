// lib/claude.ts — image identification via Claude Vision, routed through
// Cloudflare AI Gateway (BYOK: ANTHROPIC_API_KEY travels on each request,
// the gateway proxies to Anthropic rather than storing the key).
//
// Contract: identifyImage() THROWS on failure (ClaudeVisionError), unlike
// mapbox.ts's never-throw contract. This is deliberate — a failed
// identification has no honest "empty" result to fall back to, so the
// caller (routes/identify.ts) must decide how to surface the failure
// rather than have it silently masked as a low-confidence result.

import type { Env } from '../types';

// claude-sonnet-5 for identification accuracy, since this is the core
// product feature. claude-haiku-4-5-20251001 is a viable cheaper swap if
// per-identification cost matters more than squeezing out extra accuracy —
// worth revisiting once real usage volume is known.
const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 500;
const REQUEST_TIMEOUT_MS = 15000;

const SYSTEM_PROMPT = `You identify landmarks, buildings, and points of interest from photos taken by a traveler.

Respond with ONLY a JSON object, no markdown code fences, no explanation before or after. The object must have exactly these fields:
{
  "name": string — the specific name of what's shown, or a concise descriptive label if you can't identify it specifically,
  "detail": string — one to three sentences of relevant context (history, significance, what it's used for),
  "confidence": number — your confidence in the identification, from 0.0 to 1.0
}

If you cannot identify anything specific in the image, still return valid JSON with your best general description and a low confidence value. Never omit a field.`;

export interface ClaudeIdentification {
  name: string;
  detail: string;
  confidence: number;
}

export class ClaudeVisionError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ClaudeVisionError';
  }
}

export async function identifyImage(
  env: Env,
  photoBytes: ArrayBuffer,
  mimeType: string
): Promise<ClaudeIdentification> {
  const base64 = arrayBufferToBase64(photoBytes);
  const url = `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/anthropic/v1/messages`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mimeType,
                  data: base64,
                },
              },
              {
                type: 'text',
                text: "Identify what's shown in this photo.",
              },
            ],
          },
        ],
      }),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ClaudeVisionError(`Claude Vision request timed out after ${REQUEST_TIMEOUT_MS}ms`, err);
    }
    throw new ClaudeVisionError('Claude Vision request failed to send', err);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '<unreadable body>');
    throw new ClaudeVisionError(`Claude Vision returned ${response.status}: ${bodyText}`);
  }

  const payload = await response.json().catch((err) => {
    throw new ClaudeVisionError('Claude Vision response was not valid JSON', err);
  });

  const textBlock = extractTextBlock(payload);
  if (textBlock === null) {
    throw new ClaudeVisionError('Claude Vision response had no text content block');
  }

  return parseIdentification(textBlock);
}

// ---- Helpers ----

function extractTextBlock(payload: unknown): string | null {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'content' in payload &&
    Array.isArray((payload as { content: unknown }).content)
  ) {
    const content = (payload as { content: Array<{ type?: string; text?: string }> }).content;
    const block = content.find((b) => b.type === 'text' && typeof b.text === 'string');
    return block?.text ?? null;
  }
  return null;
}

function parseIdentification(rawText: string): ClaudeIdentification {
  // Strip markdown code fences in case the model adds them despite instructions.
  const cleaned = rawText.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new ClaudeVisionError('Claude Vision response was not parseable JSON', err);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).name !== 'string' ||
    typeof (parsed as Record<string, unknown>).detail !== 'string' ||
    typeof (parsed as Record<string, unknown>).confidence !== 'number'
  ) {
    throw new ClaudeVisionError('Claude Vision response was missing required fields');
  }

  const result = parsed as ClaudeIdentification;
  if (result.confidence < 0 || result.confidence > 1) {
    throw new ClaudeVisionError(`Claude Vision returned an out-of-range confidence: ${result.confidence}`);
  }

  return result;
}

// Chunked to avoid "Maximum call stack size exceeded" from spreading a large
// Uint8Array into String.fromCharCode(...bytes) — a real failure mode for
// photo-sized buffers, not a theoretical one.
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
