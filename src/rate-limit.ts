export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

/**
 * Token bucket per API key, refilled continuously. Bursts up to the
 * per-minute limit are allowed, after that requests are spaced out.
 * State lives in this process, so with several replicas each one counts
 * on its own.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  take(key: string, perMinute: number): RateLimitResult {
    const now = this.now();
    const refillPerMs = perMinute / 60_000;
    const bucket = this.buckets.get(key) ?? { tokens: perMinute, updatedAt: now };

    bucket.tokens = Math.min(perMinute, bucket.tokens + (now - bucket.updatedAt) * refillPerMs);
    bucket.updatedAt = now;
    this.buckets.set(key, bucket);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
    }
    return { allowed: false, remaining: 0, retryAfterMs: Math.ceil((1 - bucket.tokens) / refillPerMs) };
  }
}
