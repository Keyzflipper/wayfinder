// index.ts — Worker entry point.
//
// Responsibilities: CORS (once, here — not duplicated per-route), routing,
// and the top-level error boundary that catches whatever routes/identify.ts
// deliberately lets escape (see the `throw err` for non-ClaudeVisionError
// failures there).
//
// All routes below have real handlers now: /api/identify, /api/nearby,
// /api/restaurants, /api/guide (upload), /api/guide/nearby (lookup),
// /api/trips, /api/finds, and /api/photos.

import type { Env } from './types';
import { handleIdentify } from './routes/identify';
import { handleNearby } from './routes/nearby';
import { handleRestaurants } from './routes/restaurants';
import { handleGuideUpload } from './routes/guide-upload';
import { handleGuideLookup } from './routes/guide-lookup';
import { handleListTrips } from './routes/trips';
import { handleListFinds } from './routes/finds';
import { handleGetPhoto } from './routes/photo';

// Wildcard origin: appropriate for a personal, single-user app with no
// cookie-based auth. Revisit with an explicit allowlist if this ever
// becomes multi-user or session-authenticated.
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const url = new URL(request.url);

      if (url.pathname === '/api/health' && request.method === 'GET') {
        return withCors(jsonResponse(200, { status: 'ok', environment: env.ENVIRONMENT }));
      }

      if (url.pathname === '/api/identify' && request.method === 'POST') {
        return withCors(await handleIdentify(request, env));
      }

      if (url.pathname === '/api/nearby' && request.method === 'GET') {
        return withCors(await handleNearby(request, env));
      }

      if (url.pathname === '/api/restaurants' && request.method === 'GET') {
        return withCors(await handleRestaurants(request, env));
      }

      if (url.pathname === '/api/guide' && request.method === 'POST') {
        return withCors(await handleGuideUpload(request, env));
      }

      if (url.pathname === '/api/guide/nearby' && request.method === 'GET') {
        return withCors(await handleGuideLookup(request, env));
      }

      if (url.pathname === '/api/trips' && request.method === 'GET') {
        return withCors(await handleListTrips(env));
      }

      if (url.pathname === '/api/finds' && request.method === 'GET') {
        return withCors(await handleListFinds(request, env));
      }

      if (url.pathname === '/api/photos' && request.method === 'GET') {
        return withCors(await handleGetPhoto(request, env));
      }

      return withCors(jsonResponse(404, { error: 'not_found', message: `No route for ${request.method} ${url.pathname}` }));
    } catch (err) {
      console.error('Unhandled error in Worker fetch handler:', err);
      return withCors(
        jsonResponse(500, { error: 'internal_error', message: 'Something went wrong processing that request.' })
      );
    }
  },
};

// ---- Helpers ----

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
