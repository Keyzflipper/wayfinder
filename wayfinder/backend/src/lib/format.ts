// lib/format.ts — presentation formatting shared across routes.
// Split out of routes/identify.ts once routes/nearby.ts needed the same
// distance formatting (see the comment that used to live there).

export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)}m`;
  return `${(meters / 1000).toFixed(1)}km`;
}
