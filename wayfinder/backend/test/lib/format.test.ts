import { describe, expect, it } from 'vitest';
import { formatDistance } from '../../src/lib/format';

describe('formatDistance', () => {
  it('rounds sub-kilometer distances to whole meters', () => {
    expect(formatDistance(0)).toBe('0m');
    expect(formatDistance(180.4)).toBe('180m');
    expect(formatDistance(999.6)).toBe('1000m');
  });

  it('switches to kilometers with one decimal at 1000m and above', () => {
    expect(formatDistance(1000)).toBe('1.0km');
    expect(formatDistance(1540)).toBe('1.5km');
    expect(formatDistance(12345)).toBe('12.3km');
  });
});
