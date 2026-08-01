import { ProviderError } from "./provider-policy.js";

export type RateLimit = Readonly<{ maxConcurrency: number; requestsPerMinute: number; tokensPerMinute: number }>;
type Waiter = { tokens: number; signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: ProviderError) => void; cancel: () => void };

export class ProfileRateLimiter {
  private active = 0;
  private requests: number;
  private tokens: number;
  private updatedAt: number;
  private readonly queue: Waiter[] = [];

  constructor(private readonly limit: RateLimit, private readonly now: () => number = Date.now) {
    this.requests = limit.requestsPerMinute;
    this.tokens = limit.tokensPerMinute;
    this.updatedAt = now();
  }

  acquire(tokens: number, signal: AbortSignal): Promise<() => void> {
    if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > this.limit.tokensPerMinute) return Promise.reject(new ProviderError("OCC-AI-PROVIDER-RATE-LIMIT"));
    if (signal.aborted) return Promise.reject(new ProviderError("OCC-AI-PROVIDER-CANCELLED", false, { cause: signal.reason }));
    this.refill();
    if (this.active < this.limit.maxConcurrency && this.requests >= 1 && this.tokens >= tokens) return Promise.resolve(this.grant(tokens));
    if (this.requests < 1 || this.tokens < tokens) return Promise.reject(new ProviderError("OCC-AI-PROVIDER-RATE-LIMIT"));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        tokens, signal, resolve, reject,
        cancel: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          signal.removeEventListener("abort", waiter.cancel);
          reject(new ProviderError("OCC-AI-PROVIDER-CANCELLED", false, { cause: signal.reason }));
        },
      };
      signal.addEventListener("abort", waiter.cancel, { once: true });
      this.queue.push(waiter);
    });
  }

  private refill(): void {
    const current = this.now();
    const elapsed = Math.max(0, current - this.updatedAt);
    this.updatedAt = current;
    this.requests = Math.min(this.limit.requestsPerMinute, this.requests + elapsed * this.limit.requestsPerMinute / 60_000);
    this.tokens = Math.min(this.limit.tokensPerMinute, this.tokens + elapsed * this.limit.tokensPerMinute / 60_000);
  }

  private grant(tokens: number): () => void {
    this.requests -= 1;
    this.tokens -= tokens;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.drain();
    };
  }

  private drain(): void {
    this.refill();
    while (this.active < this.limit.maxConcurrency && this.queue.length > 0) {
      const waiter = this.queue[0]!;
      if (this.requests < 1 || this.tokens < waiter.tokens) return;
      this.queue.shift();
      waiter.signal.removeEventListener("abort", waiter.cancel);
      waiter.resolve(this.grant(waiter.tokens));
    }
  }
}
