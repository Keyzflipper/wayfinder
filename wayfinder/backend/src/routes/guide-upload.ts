// routes/guide-upload.ts — POST /api/guide
//
// Flow: accept plain pasted/typed text (no file, no PDF/EPUB parsing) ->
// chunk it -> for each chunk (up to MAX_CHUNKS), ask Claude for the one
// specific place it's about, then geocode that place via Mapbox (both steps
// degrade-gracefully per-chunk — see lib/claude.ts and lib/mapbox.ts's
// never-throw contracts for extractPlaceName/geocodePlaceName) -> batch-
// insert all chunks into guide_chunks.
//
// This used to accept PDF/EPUB file uploads (extracted via unpdf/fflate).
// That's gone — parsing arbitrary binary guidebooks turned out to fight
// Workers' platform limits (100MB request bodies, 128MB memory) for
// marginal benefit over just letting someone paste the text they actually
// want matched. guide_chunks' source_page column is repurposed here as a
// 1-based paragraph-chunk-group index rather than a real page/section
// number — it's not read for anything except ordering, so this needed no
// schema change.
//
// MAX_CHUNKS is deliberately conservative: each geocoded chunk costs two
// subrequests (Claude + Mapbox), and Workers' Free plan caps a single
// invocation at 50 subrequests total. 20 chunks * 2 = 40, leaving headroom
// for the D1 batch. Revisit once the account's actual plan/limits are
// confirmed — see the wrangler.toml deploy notes.

import type { Env, GuideUploadResponse } from '../types';
import { extractPlaceName } from '../lib/claude';
import { geocodePlaceName } from '../lib/mapbox';
import { findOrCreateTrip } from '../lib/trips';
import { jsonError } from '../lib/http';

const MAX_CHUNK_CHARS = 1500; // ~300-400 words — small enough for a focused single-place extraction, large enough to keep excerpts meaningful
const MAX_CHUNKS = 20; // see file header
const MAX_TEXT_CHARS = 60000; // generous for pasted notes/excerpts — this is typing/pasting, not a whole book
const MIN_EXTRACTION_CONFIDENCE = 0.5; // below this, skip the geocoding call entirely rather than spend a subrequest on a low-confidence guess

interface ChunkCandidate {
  sourcePage: number;
  text: string;
}

export async function handleGuideUpload(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError(400, 'invalid_json', 'Request body must be JSON.');
  }

  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

  const text = typeof record.text === 'string' ? record.text.trim() : '';
  if (text.length === 0) {
    return jsonError(400, 'missing_text', 'A non-empty "text" field is required.');
  }
  if (text.length > MAX_TEXT_CHARS) {
    return jsonError(413, 'text_too_long', `"text" exceeds the ${MAX_TEXT_CHARS}-character limit.`);
  }

  const tripName = typeof record.tripName === 'string' ? record.tripName.trim() : '';
  if (tripName.length === 0) {
    return jsonError(400, 'missing_trip_name', 'A tripName is required — every guide chunk belongs to a trip.');
  }

  const tripId = await findOrCreateTrip(env, tripName);

  // This app models one active guide per trip (guide_chunks isn't grouped by
  // upload id, and neither identify.ts's match nor guide-lookup.ts's search
  // de-dupes across uploads) — so re-uploading for the same trip replaces
  // its prior chunks rather than accumulating alongside them.
  await env.DB.prepare('DELETE FROM guide_chunks WHERE trip_id = ?').bind(tripId).run();

  // ---- Chunk the text ----
  const allCandidates: ChunkCandidate[] = chunkPageText(text, MAX_CHUNK_CHARS).map((chunkText, index) => ({
    sourcePage: index + 1,
    text: chunkText,
  }));

  const truncated = allCandidates.length > MAX_CHUNKS;
  const candidates = allCandidates.slice(0, MAX_CHUNKS);

  // ---- Per-chunk: extract a place name, then geocode it (both soft-fail) ----
  const now = new Date().toISOString();
  const rows: Array<{
    id: string;
    sourcePage: number;
    text: string;
    lat: number | null;
    lon: number | null;
    geocodeConfidence: number | null;
  }> = [];

  for (const candidate of candidates) {
    const extraction = await extractPlaceName(env, candidate.text);
    const shouldGeocode = extraction.placeName !== null && extraction.confidence >= MIN_EXTRACTION_CONFIDENCE;
    const geocoded = shouldGeocode ? await geocodePlaceName(env, extraction.placeName as string) : null;

    rows.push({
      id: crypto.randomUUID(),
      sourcePage: candidate.sourcePage,
      text: candidate.text,
      lat: geocoded?.lat ?? null,
      lon: geocoded?.lon ?? null,
      geocodeConfidence: geocoded?.confidence ?? null,
    });
  }

  if (rows.length > 0) {
    await env.DB.batch(
      rows.map((row) =>
        env.DB.prepare(
          `INSERT INTO guide_chunks (id, trip_id, source_page, text, lat, lon, geocode_confidence, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(row.id, tripId, row.sourcePage, row.text, row.lat, row.lon, row.geocodeConfidence, now)
      )
    );
  }

  const response: GuideUploadResponse = {
    tripId,
    chunksCreated: rows.length,
    chunksGeocoded: rows.filter((r) => r.lat !== null).length,
    truncated,
  };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// ---- Helpers ----

// Greedily packs paragraphs (blank-line-separated) up to maxChars per
// chunk. A single paragraph longer than maxChars on its own gets hard-split
// rather than broken on sentence boundaries — good enough for this scope;
// travel notes rarely have paragraphs anywhere near this long.
function chunkPageText(pageText: string, maxChars: number): string[] {
  const trimmed = pageText.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      if (current.length > 0) {
        chunks.push(current);
        current = '';
      }
      for (let i = 0; i < para.length; i += maxChars) {
        chunks.push(para.slice(i, i + maxChars));
      }
      continue;
    }

    const candidate = current.length > 0 ? `${current}\n\n${para}` : para;
    if (candidate.length > maxChars) {
      chunks.push(current);
      current = para;
    } else {
      current = candidate;
    }
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}
