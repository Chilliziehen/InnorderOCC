import { ProviderError } from "./provider-policy.js";

export type RetryContext = Readonly<{ operationId: string; attempt: number }>;
export type RetryOptions = Readonly<{
  operationId: string;
  deadline: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
}>;

export type OperationDeadline = Readonly<{
  expiresAt: number;
  signal: AbortSignal;
  dispose(): void;
}>;

const BACKOFF = [100, 500] as const;

export function abortProviderError(signal: AbortSignal): ProviderError {
  return signal.reason instanceof ProviderError
    ? signal.reason
    : new ProviderError("OCC-AI-PROVIDER-CANCELLED", false, { cause: signal.reason });
}

export function raceWithSignal<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  onLateValue?: (value: T) => void,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortProviderError(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      reject(abortProviderError(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    let pending: Promise<T>;
    try {
      pending = operation(signal);
    } catch (error) {
      settled = true;
      signal.removeEventListener("abort", abort);
      reject(error);
      return;
    }
    pending.then(
      (value) => {
        if (settled) {
          try { onLateValue?.(value); } catch { /* Cleanup cannot change an already-settled operation. */ }
          return;
        }
        settled = true;
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function createOperationDeadline(totalMs: number, caller: AbortSignal, now: () => number = Date.now): OperationDeadline {
  if (!Number.isSafeInteger(totalMs) || totalMs < 1) throw new ProviderError("OCC-AI-PROVIDER-POLICY");
  const controller = new AbortController();
  const expiresAt = now() + totalMs;
  const cancel = () => controller.abort(abortProviderError(caller));
  if (caller.aborted) cancel();
  else caller.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new ProviderError("OCC-AI-PROVIDER-TIMEOUT")), totalMs);
  return {
    expiresAt,
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      caller.removeEventListener("abort", cancel);
    },
  };
}

export async function executeWithRetry<T>(options: RetryOptions, operation: (context: RetryContext) => Promise<T>): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; ; attempt += 1) {
    if (options.signal?.aborted) throw abortProviderError(options.signal);
    if (now() >= options.deadline) throw new ProviderError("OCC-AI-PROVIDER-TIMEOUT");
    try {
      return await operation({ operationId: options.operationId, attempt });
    } catch (error) {
      const delay = BACKOFF[attempt];
      if (!(error instanceof ProviderError) || !error.retryable || delay === undefined) throw error;
      if (error.retryAfterMs !== undefined && (!Number.isSafeInteger(error.retryAfterMs) || error.retryAfterMs < 0 || now() + error.retryAfterMs >= options.deadline)) throw new ProviderError("OCC-AI-PROVIDER-TIMEOUT");
      if (now() + delay >= options.deadline) throw new ProviderError("OCC-AI-PROVIDER-TIMEOUT");
      if (options.signal?.aborted) throw abortProviderError(options.signal);
      let cancel: (() => void) | undefined;
      try {
        const cancellation = options.signal === undefined ? undefined : new Promise<never>((_resolve, reject) => {
          cancel = () => reject(abortProviderError(options.signal!));
          if (options.signal!.aborted) cancel();
          else options.signal!.addEventListener("abort", cancel, { once: true });
        });
        await Promise.race([
          sleep(delay),
          ...(cancellation === undefined ? [] : [cancellation]),
        ]);
      } finally {
        if (cancel !== undefined) options.signal?.removeEventListener("abort", cancel);
      }
    }
  }
}
