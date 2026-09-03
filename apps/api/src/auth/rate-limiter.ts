import { createHash } from 'node:crypto';

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  public constructor(private readonly now: () => number = Date.now) {}

  public take(scope: string, value: string, limit: number, windowMs: number): {
    allowed: boolean;
    retryAfterSeconds: number;
  } {
    const now = this.now();
    if (this.buckets.size > 20_000) this.prune(now);
    const key = `${scope}:${digest(value)}`;
    const current = this.buckets.get(key);
    if (!current || current.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    current.count += 1;
    return {
      allowed: current.count <= limit,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1_000)),
    };
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}
