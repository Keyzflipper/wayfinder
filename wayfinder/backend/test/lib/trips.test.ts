import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { findOrCreateTrip } from '../../src/lib/trips';
import { applySchema } from '../helpers';

describe('findOrCreateTrip', () => {
  beforeAll(async () => {
    await applySchema();
  });

  it('creates a new trip when none exists with that name', async () => {
    const id = await findOrCreateTrip(env, 'brand-new-trip');

    const row = await env.DB.prepare('SELECT id, name FROM trips WHERE id = ?').bind(id).first<{ id: string; name: string }>();
    expect(row).toEqual({ id, name: 'brand-new-trip' });
  });

  it('returns the existing id instead of creating a duplicate', async () => {
    const first = await findOrCreateTrip(env, 'reused-trip');
    const second = await findOrCreateTrip(env, 'reused-trip');

    expect(second).toBe(first);
    const count = await env.DB.prepare('SELECT COUNT(*) as n FROM trips WHERE name = ?').bind('reused-trip').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('bumps updated_at on reuse, not just creation', async () => {
    const id = await findOrCreateTrip(env, 'staleness-trip');
    const created = await env.DB.prepare('SELECT updated_at FROM trips WHERE id = ?').bind(id).first<{ updated_at: string }>();

    // Force a real, measurable time gap — D1's default timestamp precision
    // isn't guaranteed finer than this, so a same-millisecond second call
    // could produce an identical (not just "not earlier") updated_at.
    await new Promise((resolve) => setTimeout(resolve, 20));

    await findOrCreateTrip(env, 'staleness-trip');
    const reused = await env.DB.prepare('SELECT updated_at FROM trips WHERE id = ?').bind(id).first<{ updated_at: string }>();

    expect(new Date(reused!.updated_at).getTime()).toBeGreaterThan(new Date(created!.updated_at).getTime());
  });

  it('creates exactly one row when two calls for the same brand-new name race', async () => {
    // Regression test for the race a SELECT-then-branch implementation has:
    // both calls could see "no existing row" before either INSERT commits.
    // The atomic upsert (INSERT ... ON CONFLICT) should make this safe
    // regardless of ordering.
    const [idA, idB] = await Promise.all([
      findOrCreateTrip(env, 'racing-trip'),
      findOrCreateTrip(env, 'racing-trip'),
    ]);

    expect(idA).toBe(idB);
    const count = await env.DB.prepare('SELECT COUNT(*) as n FROM trips WHERE name = ?').bind('racing-trip').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});
