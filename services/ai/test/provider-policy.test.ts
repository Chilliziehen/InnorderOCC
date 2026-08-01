import { mkdir, mkdtemp, chmod, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { providerConfigSchema, type ProviderConfig } from "@innorder/contracts";
import { describe, expect, it, vi } from "vitest";

import { calculateAccounting } from "../src/provider/accounting.js";
import { readCredentialFile } from "../src/provider/credential-reader.js";
import { ProviderError, ProviderPolicy } from "../src/provider/provider-policy.js";
import { ProfileRateLimiter } from "../src/provider/rate-limiter.js";
import { executeWithRetry } from "../src/provider/retry-policy.js";

const ID = "00000000-0000-4000-8000-000000000001";

function config(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return providerConfigSchema.parse({
    id: ID,
    name: "test",
    origin: "https://provider.example:8443",
    apiPrefix: "/v1",
    approvedPrivateCidrs: [],
    credentialFile: "C:\\run\\secrets\\provider",
    enabled: true,
    version: 1,
    ...overrides,
  });
}

const dns = (...addresses: string[]) => async () =>
  addresses.map((address) => ({ address, family: address.includes(":") ? 6 as const : 4 as const }));

describe("provider URL and DNS policy", () => {
  it("accepts only the exact origin and fixed API prefix and pins a public address", async () => {
    const policy = new ProviderPolicy(config(), dns("93.184.216.34"));
    const target = await policy.resolve("/v1/chat/completions");

    expect(target.url.href).toBe("https://provider.example:8443/v1/chat/completions");
    expect(target.address).toBe("93.184.216.34");
    expect(target.servername).toBe("provider.example");
    expect(target.hostHeader).toBe("provider.example:8443");
  });

  it.each([
    "https://user@provider.example:8443/v1/models",
    "https://provider.example:8443/v1/models?secret=x",
    "https://provider.example:8443/v1/models#fragment",
    "https://provider.example/v1/models",
    "https://provider.example:443/v1/models",
    "https://other.example:8443/v1/models",
    "/v10/models",
    "/v1/../admin",
    "/v1/%2e%2e/admin",
    "/v1/%2Fadmin",
    "/v1/%5cadmin",
    "/v1/%252e%252e/admin",
  ])("rejects endpoint escape %s", async (endpoint) => {
    await expect(new ProviderPolicy(config(), dns("93.184.216.34")).resolve(endpoint))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-POLICY" });
  });

  it.each([
    "0.0.0.0", "10.0.0.0", "10.255.255.255",
    "100.64.0.0", "100.127.255.255",
    "127.0.0.0", "127.255.255.255", "169.254.0.0", "169.254.169.254",
    "172.16.0.0", "172.31.255.255", "192.0.0.0", "192.0.2.1", "192.168.0.0", "198.18.0.0", "198.19.255.255",
    "198.51.100.1", "203.0.113.1", "224.0.0.0", "239.255.255.255", "240.0.0.0", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "fe80::1", "fe80::1%3", "fc00::", "fdff:ffff::",
    "2001:db8::1", "ff00::1",
  ])("rejects non-public address boundary %s", async (address) => {
    await expect(new ProviderPolicy(config(), dns(address)).resolve("/v1/models"))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-ADDRESS" });
  });

  it.each(["9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0", "169.253.255.255", "169.255.255.255", "223.255.255.254", "2001:4860:4860::8888"])(
    "accepts public boundary %s", async (address) => {
      await expect(new ProviderPolicy(config(), dns(address)).resolve("/v1/models")).resolves.toMatchObject({ address });
    },
  );

  it("allows a private address only when wholly contained by an approved CIDR", async () => {
    const approved = config({ approvedPrivateCidrs: ["10.20.0.0/16", "fd12:3456::/32"] });
    await expect(new ProviderPolicy(approved, dns("10.20.255.255")).resolve("/v1/models")).resolves.toBeDefined();
    await expect(new ProviderPolicy(approved, dns("fd12:3456::1")).resolve("/v1/models")).resolves.toBeDefined();
    await expect(new ProviderPolicy(approved, dns("10.21.0.1")).resolve("/v1/models")).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-ADDRESS" });
  });

  it("rejects mixed safe and unsafe DNS answers", async () => {
    await expect(new ProviderPolicy(config(), dns("93.184.216.34", "127.0.0.1")).resolve("/v1/models"))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-ADDRESS" });
  });

  it("re-resolves on every request and rejects a rebinding sequence", async () => {
    const resolver = vi.fn()
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    const policy = new ProviderPolicy(config(), resolver);

    await expect(policy.resolve("/v1/models")).resolves.toBeDefined();
    await expect(policy.resolve("/v1/models")).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-ADDRESS" });
    expect(resolver).toHaveBeenCalledTimes(2);
  });
});

describe("credential reader", () => {
  it("reads a bounded regular file and trims one final newline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "occ-provider-"));
    const path = join(directory, "credential");
    await writeFile(path, "top-secret\n", { mode: 0o600 });
    if (process.platform !== "win32") await chmod(path, 0o600);

    const credential = await readCredentialFile(path, { maxBytes: 64, enforcePermissions: process.platform !== "win32" });
    expect(credential.toString("utf8")).toBe("top-secret");
    credential.fill(0);
  });

  it.each(["", "one\ntwo", "value\n\n", "nul\0value", "control\u0007"])("rejects invalid credential content without disclosure", async (content) => {
    const directory = await mkdtemp(join(tmpdir(), "occ-provider-"));
    const path = join(directory, "credential");
    await writeFile(path, content, { mode: 0o600 });

    const error = await readCredentialFile(path, { maxBytes: 64, enforcePermissions: false }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "OCC-AI-PROVIDER-CREDENTIAL" });
    expect(JSON.stringify(error)).not.toContain(path);
    if (content !== "") expect(JSON.stringify(error)).not.toContain(content);
  });

  it("rejects parent symlink or reparse-point traversal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "occ-provider-"));
    const target = join(directory, "target");
    const linked = join(directory, "linked");
    await mkdir(target);
    await writeFile(join(target, "credential"), "dummy-secret", { mode: 0o600 });
    await symlink(target, linked, process.platform === "win32" ? "junction" : "dir");

    await expect(readCredentialFile(join(linked, "credential"), { enforcePermissions: false }))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-CREDENTIAL" });
  });
});

describe("rate, retry, and accounting", () => {
  it("limits concurrency, supports queued cancellation, and releases permits", async () => {
    const limiter = new ProfileRateLimiter({ maxConcurrency: 1, requestsPerMinute: 60, tokensPerMinute: 1_000 }, () => 0);
    const release = await limiter.acquire(10, new AbortController().signal);
    const cancelled = new AbortController();
    const queued = limiter.acquire(10, cancelled.signal);
    cancelled.abort(new Error("stop"));
    await expect(queued).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-CANCELLED" });
    release();
    await expect(limiter.acquire(10, new AbortController().signal)).resolves.toBeTypeOf("function");
  });

  it("enforces the per-profile request and token buckets", async () => {
    let now = 0;
    const limiter = new ProfileRateLimiter({ maxConcurrency: 2, requestsPerMinute: 1, tokensPerMinute: 10 }, () => now);
    const release = await limiter.acquire(10, new AbortController().signal);
    release();
    await expect(limiter.acquire(1, new AbortController().signal)).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-RATE-LIMIT" });
    now = 60_000;
    await expect(limiter.acquire(10, new AbortController().signal)).resolves.toBeTypeOf("function");
  });

  it("retries only classified safe failures with 100/500ms backoff and a stable operation ID", async () => {
    const sleep = vi.fn(async () => undefined);
    const seen: string[] = [];
    let attempts = 0;
    const result = await executeWithRetry({ operationId: "operation-1", deadline: 1_000, now: () => 0, sleep }, async ({ operationId }) => {
      seen.push(operationId);
      attempts += 1;
      if (attempts < 3) throw new ProviderError("OCC-AI-PROVIDER-TRANSIENT", true);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(seen).toEqual(["operation-1", "operation-1", "operation-1"]);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 500]);
  });

  it("does not retry permanent, dispatched, timeout, or cancellation failures", async () => {
    for (const code of ["OCC-AI-PROVIDER-TLS", "OCC-AI-PROVIDER-DISPATCHED", "OCC-AI-PROVIDER-TIMEOUT", "OCC-AI-PROVIDER-CANCELLED"] as const) {
      const operation = vi.fn(async () => { throw new ProviderError(code, false); });
      await expect(executeWithRetry({ operationId: "op", deadline: 1_000, now: () => 0, sleep: async () => undefined }, operation)).rejects.toMatchObject({ code });
      expect(operation).toHaveBeenCalledTimes(1);
    }
  });

  it("cancels while waiting to retry without leaking the caller reason", async () => {
    const controller = new AbortController();
    const sleeping = vi.fn(async () => {
      controller.abort(new Error("caller stop"));
      await new Promise(() => undefined);
    });
    const operation = vi.fn(async () => { throw new ProviderError("OCC-AI-PROVIDER-TRANSIENT", true); });
    const error = await executeWithRetry({ operationId: "op", deadline: 1_000, now: () => 0, sleep: sleeping, signal: controller.signal }, operation).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "OCC-AI-PROVIDER-CANCELLED", cause: controller.signal.reason });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("uses validated usage or a deterministic conservative estimate without floating undercharge", () => {
    expect(calculateAccounting({ requestBytes: 8, responseBytes: 5, usage: { inputTokens: 2, outputTokens: 3 }, cost: { currency: "USD", inputMicrosPerMillionTokens: 500_001, outputMicrosPerMillionTokens: 1_000_001 } }))
      .toEqual({ inputTokens: 2, outputTokens: 3, costMicros: 6n, currency: "USD", estimated: false });
    expect(calculateAccounting({ requestBytes: 8, responseBytes: 5, cost: { currency: "USD", inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 } }))
      .toEqual({ inputTokens: 8, outputTokens: 5, costMicros: 2n, currency: "USD", estimated: true });
    expect(() => calculateAccounting({ requestBytes: 1, responseBytes: 1, usage: { inputTokens: -1, outputTokens: 0 }, cost: { currency: "USD", inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 } })).toThrow();
  });
});
