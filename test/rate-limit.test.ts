import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/rate-limit.js';

describe('RateLimiter', () => {
  it('allows a burst up to the limit, then refills over time', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);

    expect([1, 2, 3].map(() => limiter.take('key', 3).allowed)).toEqual([true, true, true]);

    const denied = limiter.take('key', 3);
    expect(denied).toEqual({ allowed: false, remaining: 0, retryAfterMs: 20_000 });

    now += 20_000;
    expect(limiter.take('key', 3).allowed).toBe(true);
    expect(limiter.take('key', 3).allowed).toBe(false);
  });

  it('keeps a separate bucket per key', () => {
    const limiter = new RateLimiter(() => 0);

    limiter.take('a', 1);

    expect(limiter.take('a', 1).allowed).toBe(false);
    expect(limiter.take('b', 1).allowed).toBe(true);
  });

  it('never refills past the limit after a long pause', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    limiter.take('key', 2);

    now += 10 * 60_000;

    expect(limiter.take('key', 2).remaining).toBe(1);
  });
});
