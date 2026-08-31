import { describe, expect, it } from 'vitest';
import { jsonError, parseCoord, parsePositiveInt } from '../../src/lib/http';

describe('parseCoord', () => {
  it('parses a valid numeric string', () => {
    expect(parseCoord('40.6892')).toBe(40.6892);
    expect(parseCoord('-74.0445')).toBe(-74.0445);
  });

  it('returns null for a missing param', () => {
    expect(parseCoord(null)).toBeNull();
  });

  it('returns null for an empty-string param instead of coercing to 0', () => {
    // Number('') is 0, and 0 is a legitimate coordinate — without an
    // explicit empty check, "?lat=" would silently resolve to Null Island
    // instead of being rejected as invalid.
    expect(parseCoord('')).toBeNull();
    expect(parseCoord('   ')).toBeNull();
  });

  it('returns null for a non-numeric string', () => {
    expect(parseCoord('abc')).toBeNull();
  });

  it('accepts a genuine 0 coordinate', () => {
    expect(parseCoord('0')).toBe(0);
  });
});

describe('parsePositiveInt', () => {
  it('returns the fallback when the param is absent', () => {
    expect(parsePositiveInt(null, 10, 100)).toBe(10);
  });

  it('rejects an empty string rather than treating it as 0', () => {
    expect(parsePositiveInt('', 10, 100)).toBeNull();
  });

  it('rejects zero, negative, non-integer, and over-max values', () => {
    expect(parsePositiveInt('0', 10, 100)).toBeNull();
    expect(parsePositiveInt('-5', 10, 100)).toBeNull();
    expect(parsePositiveInt('5.5', 10, 100)).toBeNull();
    expect(parsePositiveInt('101', 10, 100)).toBeNull();
  });

  it('accepts a valid positive integer within range', () => {
    expect(parsePositiveInt('50', 10, 100)).toBe(50);
  });
});

describe('jsonError', () => {
  it('returns a JSON response with the given status and body', async () => {
    const response = jsonError(400, 'bad_thing', 'Something was wrong.');
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'bad_thing', message: 'Something was wrong.' });
  });
});
