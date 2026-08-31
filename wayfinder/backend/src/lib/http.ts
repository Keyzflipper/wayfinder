// lib/http.ts — small HTTP/query-parsing helpers shared across routes.
// Split out once jsonError() had been copy-pasted into 6 different route
// files (identify, nearby, guide-lookup, guide-upload, finds, photo) —
// the same "extract on reuse" policy already applied to geo.ts, trips.ts,
// guideChunks.ts, and format.ts, just missed for this one.

export function jsonError(status: number, error: string, message: string): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Returns null for a missing OR blank param — `raw === null` alone isn't
// enough, since URLSearchParams.get() returns '' (not null) for "?lat=",
// and Number('') is 0, which then sails through Number.isFinite() as a
// deceptively "valid" coordinate. Caught by test/lib/http.test.ts.
export function parseCoord(raw: string | null): number | null {
  if (raw === null || raw.trim().length === 0) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

// Returns `fallback` when `raw` is absent, `null` when `raw` is present but invalid.
export function parsePositiveInt(raw: string | null, fallback: number, max: number): number | null {
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > max) return null;
  return value;
}
