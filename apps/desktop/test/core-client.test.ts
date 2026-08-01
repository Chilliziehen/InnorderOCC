import { describe, expect, it, vi } from "vitest";

import {
  CoreClientError,
  MAX_RESPONSE_BYTES,
  createCoreClient,
} from "../src/core-client";

const refreshToken = "R".repeat(43);
const tokenResponse = {
  tokenType: "Bearer" as const,
  accessToken: "access-secret",
  refreshToken,
  expiresIn: 300,
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    username: "operator",
    displayName: "Operator",
    status: "ACTIVE" as const,
    capabilities: ["orders:read"],
  },
};
const statusResponse = {
  service: "occ-core",
  version: "1.0.0",
  state: "READY" as const,
  checkedAt: "2026-08-01T12:00:00.000Z",
  components: [],
};

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function client(fetchImpl: typeof fetch, token = "access-secret") {
  return createCoreClient({
    fetch: fetchImpl,
    getOrigin: () => "https://core.example.test",
    getAccessToken: () => token,
    timeoutMs: 250,
  });
}

describe("Core client", () => {
  it("uses exact operation URLs, methods, JSON headers, and redirect errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(tokenResponse))
      .mockResolvedValueOnce(jsonResponse(tokenResponse))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(tokenResponse.user))
      .mockResolvedValueOnce(jsonResponse(statusResponse));
    const api = client(fetchImpl);

    await api.login({ username: "operator", password: "correct horse" });
    await api.refresh(refreshToken);
    await api.logout(refreshToken);
    await api.me();
    await api.systemStatus();

    expect(fetchImpl.mock.calls.map(([url, init]) => [String(url), init?.method])).toEqual([
      ["https://core.example.test/api/v1/auth/login", "POST"],
      ["https://core.example.test/api/v1/auth/refresh", "POST"],
      ["https://core.example.test/api/v1/auth/logout", "POST"],
      ["https://core.example.test/api/v1/me", "GET"],
      ["https://core.example.test/api/v1/system/status", "GET"],
    ]);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("accept")).toBe("application/json");
    }
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).has("authorization")).toBe(false);
    expect(new Headers(fetchImpl.mock.calls[3]?.[1]?.headers).get("authorization")).toBe(
      "Bearer access-secret",
    );
  });

  it("aborts requests at the configured timeout", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>((_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted")));
      }),
    );
    const pending = client(fetchImpl).systemStatus();
    const rejection = expect(pending).rejects.toMatchObject({
      name: "CoreClientError",
      problem: { code: "TIMEOUT", status: 408, retryable: true },
    });

    await vi.advanceTimersByTimeAsync(250);

    await rejection;
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it.each([
    ["missing", undefined],
    ["false small", "1"],
  ])("enforces the streaming cap with %s Content-Length", async (_label, length) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (length) headers["content-length"] = length;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, { status: 200, headers }),
    );

    await expect(client(fetchImpl).systemStatus()).rejects.toMatchObject({
      problem: { code: "RESPONSE_TOO_LARGE" },
    });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("rejects an oversized Content-Length before reading the body", async () => {
    const body = new ReadableStream();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, {
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_RESPONSE_BYTES + 1),
      },
    }));

    await expect(client(fetchImpl).systemStatus()).rejects.toMatchObject({
      problem: { code: "RESPONSE_TOO_LARGE" },
    });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("requires JSON content types and strict successful schemas", async () => {
    const nonJson = vi.fn<typeof fetch>().mockResolvedValue(new Response("<html>secret</html>", {
      headers: { "content-type": "text/html" },
    }));
    await expect(client(nonJson).systemStatus()).rejects.toMatchObject({
      problem: { code: "INVALID_CONTENT_TYPE" },
    });

    const extraField = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      ...statusResponse,
      leaked: true,
    }));
    await expect(client(extraField).systemStatus()).rejects.toMatchObject({
      problem: { code: "INVALID_RESPONSE" },
    });
  });

  it("normalizes valid problems without exposing unsafe fields", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      type: "https://core.example.test/problems/conflict",
      title: "Conflict containing secret-token",
      detail: "raw server detail",
      status: 409,
      code: "VERSION_CONFLICT",
      correlationId: "22222222-2222-4222-8222-222222222222",
      currentVersion: 8,
    }, { status: 409, headers: { "x-secret": "header-secret" } }));

    const error = await client(fetchImpl).me().catch((value: unknown) => value);

    expect(error).toBeInstanceOf(CoreClientError);
    if (!(error instanceof CoreClientError)) throw error;
    expect(error.problem).toEqual({
      code: "VERSION_CONFLICT",
      status: 409,
      correlationId: "22222222-2222-4222-8222-222222222222",
      currentVersion: 8,
      retryable: false,
    });
    expect(JSON.stringify(error)).not.toMatch(/secret|raw server detail/i);
  });

  it("makes login authentication failures generic", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      type: "https://core.example.test/problems/auth",
      title: "User operator does not exist",
      detail: "password mismatch",
      status: 401,
      code: "USER_NOT_FOUND",
      correlationId: "22222222-2222-4222-8222-222222222222",
    }, { status: 401 }));

    await expect(client(fetchImpl).login({
      username: "operator",
      password: "correct horse",
    })).rejects.toMatchObject({
      problem: {
        code: "AUTHENTICATION_FAILED",
        status: 401,
        correlationId: "22222222-2222-4222-8222-222222222222",
        retryable: false,
      },
    });
  });

  it.each([
    [401, "application/json", "{"],
    [403, "text/html", "<html>secret</html>"],
  ])("makes HTTP %i login failures generic for malformed responses", async (status, contentType, body) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, {
      status,
      headers: { "content-type": contentType },
    }));

    await expect(client(fetchImpl).login({
      username: "operator",
      password: "correct horse",
    })).rejects.toEqual(expect.objectContaining({
      problem: {
        code: "AUTHENTICATION_FAILED",
        status,
        retryable: false,
      },
    }));
  });

  it("uses HTTP status for login normalization and omits mismatched problem metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      type: "https://core.example.test/problems/auth",
      title: "Wrong status",
      status: 500,
      code: "SECRET_INTERNAL_CODE",
      correlationId: "22222222-2222-4222-8222-222222222222",
    }, { status: 401 }));

    await expect(client(fetchImpl).login({
      username: "operator",
      password: "correct horse",
    })).rejects.toEqual(expect.objectContaining({
      problem: {
        code: "AUTHENTICATION_FAILED",
        status: 401,
        retryable: false,
      },
    }));
  });

  it("rejects Problem Details whose status disagrees with HTTP", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      type: "https://core.example.test/problems/conflict",
      title: "Wrong status",
      status: 500,
      code: "INTERNAL_ERROR",
      correlationId: "22222222-2222-4222-8222-222222222222",
    }, { status: 409 }));

    await expect(client(fetchImpl).me()).rejects.toMatchObject({
      problem: { code: "HTTP_ERROR", status: 409, retryable: false },
    });
  });
});
