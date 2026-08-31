import { describe, expect, it } from 'vitest';
import { haversineMeters } from '../../src/lib/geo';

describe('haversineMeters', () => {
  it('returns 0 for identical points', () => {
    expect(haversineMeters(40.6892, -74.0445, 40.6892, -74.0445)).toBe(0);
  });

  it('computes a known real-world distance within a small tolerance', () => {
    // Statue of Liberty -> Empire State Building, ~8.6km per public reference distances.
    const distance = haversineMeters(40.6892, -74.0445, 40.7484, -73.9857);
    expect(distance).toBeGreaterThan(8000);
    expect(distance).toBeLessThan(9200);
  });

  it('is symmetric', () => {
    const a = haversineMeters(51.5007, -0.1246, 48.8584, 2.2945);
    const b = haversineMeters(48.8584, 2.2945, 51.5007, -0.1246);
    expect(a).toBeCloseTo(b, 6);
  });
});
