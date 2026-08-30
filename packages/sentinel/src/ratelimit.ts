/**
 * Token-bucket rate limiting for the error-ingest endpoint.
 *
 * An app in a crash loop can emit thousands of events a second, and every one of
 * them arrives on the path that decides whether to wake a healing agent. The
 * bucket keeps a genuine burst of simultaneous crashes reportable while refusing
 * to let a runaway app - or anything pretending to be one - drive the scheduler.
 */

export interface RateLimiterOptions {
  /** Sustained refill rate. */
  perMinute: number;
  /** Bucket depth: how many events may arrive at once before throttling starts. */
  burst: number;
  /** Idle buckets older than this are dropped so the map cannot grow forever. */
  idleEvictMs?: number;
}

interface Bucket {
  tokens: number;
  last: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly perMs: number;
  private readonly burst: number;
  private readonly idleEvictMs: number;

  constructor(opts: RateLimiterOptions) {
    this.perMs = Math.max(0, opts.perMinute) / 60_000;
    this.burst = Math.max(1, opts.burst);
    this.idleEvictMs = opts.idleEvictMs ?? 10 * 60_000;
  }

  /** Consume one token for `key`. False means the caller is over its rate. */
  allow(key: string, now = Date.now()): boolean {
    // Unlimited when no rate is configured.
    if (this.perMs <= 0) return true;

    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.burst, last: now };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.burst, b.tokens + (now - b.last) * this.perMs);
      b.last = now;
    }

    if (this.buckets.size > 1000) this.evict(now);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Seconds until `key` has a token again; 0 when it already does. */
  retryAfter(key: string, now = Date.now()): number {
    const b = this.buckets.get(key);
    if (!b || this.perMs <= 0 || b.tokens >= 1) return 0;
    return Math.ceil((1 - b.tokens) / this.perMs / 1000);
  }

  private evict(now: number): void {
    for (const [key, b] of this.buckets) {
      if (now - b.last > this.idleEvictMs) this.buckets.delete(key);
    }
  }
}
