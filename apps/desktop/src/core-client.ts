import {
  SystemStatusSchema,
  currentUserSchema,
  loginRequestSchema,
  problemDetailsSchema,
  refreshRequestSchema,
  tokenResponseSchema,
  type CurrentUser,
  type LoginRequest,
  type SystemStatus,
  type TokenResponse,
} from "@innorder/contracts";
import type { ZodType } from "zod";

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface ProblemReceipt {
  code: string;
  status: number;
  correlationId?: string;
  currentVersion?: number;
  retryable: boolean;
}

export class CoreClientError extends Error {
  readonly problem: ProblemReceipt;

  constructor(problem: ProblemReceipt) {
    super("Core request failed");
    this.name = "CoreClientError";
    this.problem = problem;
  }
}

export interface CoreClient {
  login(input: LoginRequest): Promise<TokenResponse>;
  refresh(refreshToken: string): Promise<TokenResponse>;
  logout(refreshToken: string): Promise<void>;
  me(): Promise<CurrentUser>;
  systemStatus(): Promise<SystemStatus>;
}

interface CoreClientOptions {
  fetch: typeof fetch;
  getOrigin: () => string;
  getAccessToken: () => string | null;
  timeoutMs: number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

type Operation = "login" | "refresh" | "logout" | "me" | "systemStatus";

function receipt(code: string, status: number): ProblemReceipt {
  return {
    code,
    status,
    retryable: status === 408 || status === 425 || status === 429 || status >= 500,
  };
}

function isJson(contentType: string | null): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType?.endsWith("+json") === true;
}

async function readBounded(response: Response, controller: AbortController): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    controller.abort();
    await response.body?.cancel();
    throw new CoreClientError(receipt("RESPONSE_TOO_LARGE", 502));
  }
  if (!isJson(response.headers.get("content-type"))) {
    controller.abort();
    await response.body?.cancel();
    throw new CoreClientError(receipt("INVALID_CONTENT_TYPE", 502));
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new CoreClientError(receipt("INVALID_RESPONSE", 502));
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        controller.abort();
        await reader.cancel();
        throw new CoreClientError(receipt("RESPONSE_TOO_LARGE", 502));
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CoreClientError(receipt("INVALID_RESPONSE", 502));
  }
}

export function createCoreClient(options: CoreClientOptions): CoreClient {
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const cancel = options.clearTimeout ?? globalThis.clearTimeout;

  async function request<T>(
    operation: Operation,
    path: string,
    method: "GET" | "POST",
    schema: ZodType<T> | null,
    body?: unknown,
    authenticated = false,
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = schedule(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
    const headers = new Headers({ accept: "application/json" });
    if (body !== undefined) headers.set("content-type", "application/json");
    if (authenticated) {
      const accessToken = options.getAccessToken();
      if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
    }

    try {
      const response = await options.fetch(new URL(path, options.getOrigin()), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: controller.signal,
      });
      if (operation === "logout" && response.status === 204) return undefined as T;

      if (operation === "login" && (response.status === 401 || response.status === 403)) {
        let correlationId: string | undefined;
        try {
          const value = await readBounded(response, controller);
          const parsed = problemDetailsSchema.safeParse(value);
          if (parsed.success && parsed.data.status === response.status) {
            correlationId = parsed.data.correlationId;
          }
        } catch {
          // Authentication failures remain generic even for malformed responses.
        }
        throw new CoreClientError({
          ...receipt("AUTHENTICATION_FAILED", response.status),
          ...(correlationId === undefined ? {} : { correlationId }),
        });
      }

      const value = await readBounded(response, controller);
      if (!response.ok) {
        const parsed = problemDetailsSchema.safeParse(value);
        if (parsed.success) {
          const problem = parsed.data;
          if (problem.status !== response.status) {
            throw new CoreClientError(receipt("HTTP_ERROR", response.status));
          }
          throw new CoreClientError({
            ...receipt(problem.code, problem.status),
            correlationId: problem.correlationId,
            ...(problem.currentVersion === undefined
              ? {}
              : { currentVersion: problem.currentVersion }),
          });
        }
        throw new CoreClientError(receipt("HTTP_ERROR", response.status));
      }
      if (!schema) throw new CoreClientError(receipt("INVALID_RESPONSE", 502));
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new CoreClientError(receipt("INVALID_RESPONSE", 502));
      return parsed.data;
    } catch (error) {
      if (error instanceof CoreClientError) throw error;
      if (timedOut) throw new CoreClientError(receipt("TIMEOUT", 408));
      throw new CoreClientError(receipt("NETWORK_ERROR", 503));
    } finally {
      cancel(timeout);
    }
  }

  return {
    login(input) {
      return request("login", "/api/v1/auth/login", "POST", tokenResponseSchema, loginRequestSchema.parse(input));
    },
    refresh(refreshToken) {
      const input = refreshRequestSchema.parse({ refreshToken });
      return request("refresh", "/api/v1/auth/refresh", "POST", tokenResponseSchema, input);
    },
    logout(refreshToken) {
      const input = refreshRequestSchema.parse({ refreshToken });
      return request("logout", "/api/v1/auth/logout", "POST", null, input, true);
    },
    me() {
      return request("me", "/api/v1/me", "GET", currentUserSchema, undefined, true);
    },
    systemStatus() {
      return request("systemStatus", "/api/v1/system/status", "GET", SystemStatusSchema);
    },
  };
}
