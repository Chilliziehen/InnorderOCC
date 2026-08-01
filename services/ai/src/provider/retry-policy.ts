import { ProviderError } from "./provider-policy.js";

export type RetryContext = Readonly<{ operationId: string; attempt: number }>;
export type RetryOptions = Readonly<{
  operationId: string;
  deadline: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
}>;

const BACKOFF = [100, 500] as const;

export async function executeWithRetry<T>(options: RetryOptions, operation: (context: RetryContext) => Promise<T>): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation({ operationId: options.operationId, attempt });
    } catch (error) {
      const delay = BACKOFF[attempt];
      if (!(error instanceof ProviderError) || !error.retryable || delay === undefined) throw error;
      const wait = error.retryAfterMs === undefined ? delay : Math.max(delay, error.retryAfterMs);
      if (!Number.isSafeInteger(wait) || wait < 0 || now() + wait >= options.deadline) throw new ProviderError("OCC-AI-PROVIDER-TIMEOUT");
      if (options.signal?.aborted) throw new ProviderError("OCC-AI-PROVIDER-CANCELLED", false, { cause: options.signal.reason });
      let cancel: (() => void) | undefined;
      try {
        const cancellation = options.signal === undefined ? undefined : new Promise<never>((_resolve, reject) => {
          cancel = () => reject(new ProviderError("OCC-AI-PROVIDER-CANCELLED", false, { cause: options.signal!.reason }));
          if (options.signal!.aborted) cancel();
          else options.signal!.addEventListener("abort", cancel, { once: true });
        });
        await Promise.race([
          sleep(wait),
          ...(cancellation === undefined ? [] : [cancellation]),
        ]);
      } finally {
        if (cancel !== undefined) options.signal?.removeEventListener("abort", cancel);
      }
    }
  }
}
