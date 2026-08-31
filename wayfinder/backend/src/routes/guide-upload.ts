// routes/guide-upload.ts — POST /api/guide
//
// Flow: parse FormData -> extract text from a PDF (unpdf) or EPUB (lib/epub.ts)
// (fail-loud: a guide with no readable text is useless, mirrors identify.ts's
// Claude Vision failure handling) -> only on success: persist the file to R2
// -> chunk each unit's text -> for each chunk (up to MAX_CHUNKS), ask Claude
// for the one specific place it's about, then geocode that place via Mapbox
// (both steps degrade-gracefully per-chunk — see lib/claude.ts and
// lib/mapbox.ts's never-throw contracts for extractPlaceName/geocodePlaceName)
// -> batch-insert all chunks into guide_chunks.
//
// PDF and EPUB extraction both reduce to the same shape — an ordered list of
// unit texts (PDF pages, EPUB spine sections) — so everything downstream of
// extraction (chunking, geocoding, storage) is format-agnostic. guide_chunks'
// source_page column holds a PDF page number or an EPUB spine index
// depending on format; it's a 1-based position either way, not reused for
// anything else, so no schema change was needed to support both.
//
// MAX_CHUNKS is deliberately conservative: each geocoded chunk costs two
// subrequests (Claude + Mapbox), and Workers' Free plan caps a single
// invocation at 50 subrequests total. 20 chunks * 2 = 40, leaving
// headroom for the R2 write and D1 batch. Revisit once the account's
// actual plan/limits are confirmed — see the wrangler.toml deploy notes.

import type { Env, GuideUploadResponse } from '../types';
import { getDocumentProxy, extractText } from 'unpdf';
import { extractEpubText } from '../lib/epub';
import { extractPlaceName } from '../lib/claude';
import { geocodePlaceName } from '../lib/mapbox';
import { findOrCreateTrip } from '../lib/trips';
import { jsonError } from '../lib/http';

const MAX_CHUNK_CHARS = 1500; // ~300-400 words — small enough for a focused single-place extraction, large enough to keep excerpts meaningful
const MAX_CHUNKS = 20; // see file header
const MIN_EXTRACTION_CONFIDENCE = 0.5; // below this, skip the geocoding call entirely rather than spend a subrequest on a low-confidence guess

type GuideFormat = 'pdf' | 'epub';

interface ChunkCandidate {
  sourcePage: number;
  text: string;
}

export async function handleGuideUpload(request: Request, env: Env): Promise<Response> {
  // ---- Parse incoming form ----
  let form: FormData;
  try {
    form = await request.formData();
  } catch (err) {
    return jsonError(400, 'invalid_form', 'Could not parse multipart form data.');
  }

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return jsonError(400, 'missing_file', 'No guide file (PDF or EPUB) was included in the request.');
  }

  const format = detectGuideFormat(file);
  if (format === null) {
    return jsonError(400, 'unsupported_format', 'Guide must be a PDF or EPUB file.');
  }

  const maxBytes = Number(env.MAX_GUIDE_UPLOAD_BYTES);
  if (file.size > maxBytes) {
    return jsonError(413, 'file_too_large', `Guide exceeds the ${maxBytes}-byte limit.`);
  }

  const rawTripName = form.get('tripName');
  const tripName = typeof rawTripName === 'string' ? rawTripName.trim() : '';
  if (tripName.length === 0) {
    return jsonError(400, 'missing_trip_name', 'A tripName is required — every guide chunk belongs to a trip.');
  }

  // ---- Extract text (fail-loud: an unreadable guide is useless) ----
  const fileBytes = await file.arrayBuffer();

  let totalSections: number;
  let sectionTexts: string[];
  try {
    if (format === 'pdf') {
      // pdf.js takes ownership of the buffer backing the Uint8Array it's
      // given — it transfers/detaches it internally rather than copying, so
      // parsing silently zeroes out `fileBytes` unless we hand it an
      // independent copy. Confirmed empirically: without .slice(0) here,
      // the R2 write below stores a 0-byte object every time. fflate (the
      // EPUB path) doesn't have this behavior, so it needs no such copy.
      const doc = await getDocumentProxy(new Uint8Array(fileBytes.slice(0)));
      const extracted = await extractText(doc, { mergePages: false });
      totalSections = extracted.totalPages;
      sectionTexts = extracted.text;
    } else {
      const extracted = await extractEpubText(fileBytes);
      totalSections = extracted.totalSections;
      sectionTexts = extracted.sectionTexts;
    }
  } catch (err) {
    console.error(`Guide text extraction failed (${format}):`, err);
    return jsonError(502, 'guide_parse_failed', "Couldn't read that guide. Try a different file.");
  }

  // ---- Only now: persist ----
  const tripId = await findOrCreateTrip(env, tripName);

  // This app models one active guide per trip (guide_chunks isn't grouped by
  // upload/guide id, and neither identify.ts's match nor guide-lookup.ts's
  // search de-dupes across uploads) — so re-uploading for the same trip
  // replaces its prior chunks rather than accumulating alongside them.
  await env.DB.prepare('DELETE FROM guide_chunks WHERE trip_id = ?').bind(tripId).run();

  const extension = format === 'pdf' ? 'pdf' : 'epub';
  const defaultContentType = format === 'pdf' ? 'application/pdf' : 'application/epub+zip';
  const guideKey = `${tripId}/${crypto.randomUUID()}.${extension}`;
  await env.GUIDES.put(guideKey, fileBytes, {
    httpMetadata: { contentType: file.type || defaultContentType },
  });

  // ---- Chunk every section's text ----
  const allCandidates: ChunkCandidate[] = [];
  sectionTexts.forEach((sectionText, index) => {
    for (const chunkText of chunkPageText(sectionText, MAX_CHUNK_CHARS)) {
      allCandidates.push({ sourcePage: index + 1, text: chunkText });
    }
  });

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
    totalSections,
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

function detectGuideFormat(file: File): GuideFormat | null {
  const name = file.name.toLowerCase();
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (file.type === 'application/epub+zip' || name.endsWith('.epub')) return 'epub';
  return null;
}

// Greedily packs paragraphs (blank-line-separated) up to maxChars per
// chunk. A single paragraph longer than maxChars on its own gets hard-split
// rather than broken on sentence boundaries — good enough for this scope;
// travel-guide prose rarely has paragraphs anywhere near this long.
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
