// routes/photo.ts — GET /api/photos?key=...
//
// Streams a captured photo back out of the PHOTOS bucket. Keys are UUID-
// named and never rewritten once identify.ts writes them (see that file's
// header comment), so a long, immutable cache lifetime is correct here —
// not just a performance nicety.

import type { Env } from '../types';

export async function handleGetPhoto(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (key === null || key.trim().length === 0) {
    return jsonError(400, 'missing_key', 'Query param "key" is required.');
  }

  const object = await env.PHOTOS.get(key);
  if (object === null) {
    return jsonError(404, 'photo_not_found', 'No photo exists for that key.');
  }

  return new Response(object.body, {
    status: 200,
    headers: {
      'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}

function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
