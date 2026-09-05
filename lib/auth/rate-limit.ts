import "server-only";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  ok: boolean;
  retryAfterSeconds: number;
  remaining: number;
}

export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterSeconds: 0, remaining: limit - 1 };
  }
  if (bucket.count >= limit) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      remaining: 0,
    };
  }
  bucket.count += 1;
  return { ok: true, retryAfterSeconds: 0, remaining: limit - bucket.count };
}

export function resetRateLimit(key: string): void {
  buckets.delete(key);
}

export function rateLimitCount(key: string): number {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) return 0;
  return bucket.count;
}
