import { ProviderError } from "./provider-policy.js";
import { abortProviderError } from "./retry-policy.js";

export type RateLimit = Readonly<{ maxConcurrency: number; requestsPerMinute: number; tokensPerMinute: number }>;
type Waiter = { tokens: number; signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: ProviderError) => void; cancel: () => void };

export class ProfileRateLimiter {
  private active = 0;
  private requests: number;
  private tokens: number;
  private updatedAt: number;
  private readonly queue: Waiter[] = [];
  private wakeup: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly limit: RateLimit, private readonly now: () => number = Date.now) {
    this.requests = limit.requestsPerMinute;
    this.tokens = limit.tokensPerMinute;
    this.updatedAt = now();
  }

  acquire(tokens: number, signal: AbortSignal): Promise<() => void> {
    if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > this.limit.tokensPerMinute) return Promise.reject(new ProviderError("OCC-AI-PROVIDER-RATE-LIMIT"));
    if (signal.aborted) return Promise.reject(abortProviderError(signal));
    this.refill();
    if (this.queue.length === 0 && this.active < this.limit.maxConcurrency && this.requests >= 1 && this.tokens >= tokens) return Promise.resolve(this.grant(tokens));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        tokens, signal, resolve, reject,
        cancel: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          signal.removeEventListener("abort", waiter.cancel);
          reject(abortProviderError(signal));
          this.schedule();
        },
      };
      signal.addEventListener("abort", waiter.cancel, { once: true });
      this.queue.push(waiter);
      this.drain();
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
    if (this.wakeup !== undefined) {
      clearTimeout(this.wakeup);
      this.wakeup = undefined;
    }
    this.refill();
    while (this.active < this.limit.maxConcurrency && this.queue.length > 0) {
      const waiter = this.queue[0]!;
      if (this.requests < 1 || this.tokens < waiter.tokens) break;
      this.queue.shift();
      waiter.signal.removeEventListener("abort", waiter.cancel);
      waiter.resolve(this.grant(waiter.tokens));
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.wakeup !== undefined) {
      clearTimeout(this.wakeup);
      this.wakeup = undefined;
    }
    if (this.queue.length === 0 || this.active >= this.limit.maxConcurrency) return;
    this.refill();
    const waiter = this.queue[0]!;
    const requestWait = this.requests >= 1 ? 0 : (1 - this.requests) * 60_000 / this.limit.requestsPerMinute;
    const tokenWait = this.tokens >= waiter.tokens ? 0 : (waiter.tokens - this.tokens) * 60_000 / this.limit.tokensPerMinute;
    const delay = Math.max(1, Math.ceil(Math.max(requestWait, tokenWait)));
    this.wakeup = setTimeout(() => {
      this.wakeup = undefined;
      this.drain();
    }, delay);
  }
}
