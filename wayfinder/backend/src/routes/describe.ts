// routes/describe.ts — GET /api/describe
//
// "Why is this worth knowing about?" for a single named place, via Claude's
// web_search tool (lib/claude.ts's describeNearbyPlace()). Deliberately
// takes one place at a time rather than describing every result in a list —
// each call is a real, billed web search, so this only gets called for the
// one place walking mode actually decided to announce, not speculatively
// for a whole page of nearby results.

import type { Env, DescribeResponse } from '../types';
import { describeNearbyPlace } from '../lib/claude';
import { jsonError, parseCoord } from '../lib/http';

export async function handleDescribe(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const params = url.searchParams;

  const name = params.get('name')?.trim();
  if (!name) {
    return jsonError(400, 'missing_name', 'Query param "name" is required.');
  }

  const lat = parseCoord(params.get('lat'));
  const lon = parseCoord(params.get('lon'));
  if (lat === null || lon === null) {
    return jsonError(400, 'invalid_coords', 'Query params "lat" and "lon" are required and must be finite numbers.');
  }

  const locationContext = `near ${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  const description = await describeNearbyPlace(env, name, locationContext);

  const response: DescribeResponse = { description };
  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
