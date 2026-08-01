import { constants } from "node:fs";
import { mkdir, mkdtemp, chmod, lstat, open, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { providerConfigSchema, type ProviderConfig } from "@innorder/contracts";
import { describe, expect, it, vi } from "vitest";

import { calculateAccounting } from "../src/provider/accounting.js";
import { readCredentialFile, type CredentialFileSystem, type CredentialMetadata } from "../src/provider/credential-reader.js";
import { ProviderError, ProviderPolicy } from "../src/provider/provider-policy.js";
import { ProfileRateLimiter } from "../src/provider/rate-limiter.js";
import { createOperationDeadline, executeWithRetry } from "../src/provider/retry-policy.js";

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

function metadata(stat: Awaited<ReturnType<typeof lstat>>, trustedAcl = true): CredentialMetadata {
  return {
    type: stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
    mode: stat.mode, uid: stat.uid, dev: BigInt(stat.dev), ino: BigInt(stat.ino), size: BigInt(stat.size), trustedAcl,
  };
}

const testCredentialFileSystem: CredentialFileSystem = {
  platform: process.platform === "win32" ? "windows-verified" : "posix",
  inspect: async (path) => metadata(await lstat(path)),
  openNoFollow: async (path) => {
    const handle = await open(path, constants.O_RDONLY | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0));
    return {
      inspect: async () => metadata(await handle.stat()),
      read: async (buffer) => (await handle.read(buffer, 0, buffer.length, 0)).bytesRead,
      close: async () => handle.close(),
    };
  },
};

function credentialOptions(trustedRoot: string) {
  return {
    trustedRoot,
    fileSystem: testCredentialFileSystem,
    trustedOwnerIds: [typeof process.getuid === "function" ? process.getuid() : 0],
    serviceUid: -1,
    maxBytes: 64,
  } as const;
}

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
    "::", "::1", "::127.0.0.1", "::10.0.0.1", "::169.254.169.254",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
    "64:ff9b::7f00:1", "64:ff9b::a00:1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::7f00:1",
    "2001::1", "2001:0000:4136:e378:8000:63bf:3fff:fdd2", "2002:7f00:1::", "2002:a9fe:a9fe::",
    "2001:4860:0:1:0:5efe:7f00:1", "2001:4860:0:1:0:5efe:a9fe:a9fe",
    "fe80::1", "fe80::1%3", "fec0::", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "fc00::", "fdff:ffff::", "2001:db8::1", "ff00::1",
  ])("rejects non-public address boundary %s", async (address) => {
    await expect(new ProviderPolicy(config(), dns(address)).resolve("/v1/models"))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-ADDRESS" });
  });

  it.each(["9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0", "169.253.255.255", "169.255.255.255", "223.255.255.254", "::ffff:93.184.216.34", "2001:4860:4860::8888", "2606:4700:4700::1111"])(
    "accepts public boundary %s", async (address) => {
      await expect(new ProviderPolicy(config(), dns(address)).resolve("/v1/models")).resolves.toMatchObject({ address });
    },
  );

  it("allows a private address only when wholly contained by an approved CIDR", async () => {
    const approved = config({ approvedPrivateCidrs: ["10.20.0.0/16", "fd12:3456::/32"] });
    await expect(new ProviderPolicy(approved, dns("10.20.255.255")).resolve("/v1/models")).resolves.toBeDefined();
    await expect(new ProviderPolicy(approved, dns("::ffff:10.20.0.1")).resolve("/v1/models")).resolves.toBeDefined();
    await expect(new ProviderPolicy(approved, dns("fd12:3456::1")).resolve("/v1/models")).resolves.toBeDefined();
    await expect(new ProviderPolicy(approved, dns("10.21.0.1")).resolve("/v1/models")).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-ADDRESS" });
    for (const transition of ["::10.20.0.1", "64:ff9b::a14:1", "2001:4860:0:1:0:5efe:a14:1"]) {
      await expect(new ProviderPolicy(approved, dns(transition)).resolve("/v1/models")).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-ADDRESS" });
    }
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

    const credential = await readCredentialFile(path, credentialOptions(directory));
    expect(credential.toString("utf8")).toBe("top-secret");
    credential.fill(0);
  });

  it.each(["", "one\ntwo", "value\n\n", "nul\0value", "control\u0007"])("rejects invalid credential content without disclosure", async (content) => {
    const directory = await mkdtemp(join(tmpdir(), "occ-provider-"));
    const path = join(directory, "credential");
    await writeFile(path, content, { mode: 0o600 });

    const error = await readCredentialFile(path, credentialOptions(directory)).catch((caught: unknown) => caught);
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

    await expect(readCredentialFile(join(linked, "credential"), credentialOptions(directory)))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-CREDENTIAL" });
  });

  it("requires a direct normalized descendant of the configured trusted root", async () => {
    const root = await mkdtemp(join(tmpdir(), "occ-provider-root-"));
    const outside = await mkdtemp(join(tmpdir(), "occ-provider-outside-"));
    const path = join(outside, "credential");
    await writeFile(path, "dummy-secret", { mode: 0o600 });
    const error = await readCredentialFile(path, credentialOptions(root)).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "OCC-AI-PROVIDER-CREDENTIAL" });
    expect(JSON.stringify(error)).not.toContain(path);
  });

  it("rejects writable trusted ancestors and ancestor identity changes after open", async () => {
    const root = process.platform === "win32" ? "C:\\run\\secrets" : "/run/secrets";
    const path = join(root, "provider", "credential");
    const base: CredentialMetadata = { type: "directory", mode: 0o755, uid: 0, dev: 1n, ino: 1n, size: 0n, trustedAcl: true };
    const file: CredentialMetadata = { ...base, type: "file", mode: 0o600, ino: 3n, size: 12n };
    const writable: CredentialFileSystem = {
      platform: "posix",
      inspect: async (candidate) => candidate === join(root, "provider") ? { ...base, mode: 0o775, ino: 2n } : candidate === path ? file : base,
      openNoFollow: async () => ({ inspect: async () => file, read: async () => 12, close: async () => undefined }),
    };
    await expect(readCredentialFile(path, { trustedRoot: root, fileSystem: writable, trustedOwnerIds: [0], serviceUid: 1000 }))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-CREDENTIAL" });

    let rootChecks = 0;
    const swapped: CredentialFileSystem = {
      platform: "posix",
      inspect: async (candidate) => {
        if (candidate === root) return { ...base, ino: ++rootChecks === 1 ? 1n : 99n };
        return candidate === path ? file : { ...base, ino: 2n };
      },
      openNoFollow: async () => ({ inspect: async () => file, read: async (buffer) => { buffer.write("dummy-secret"); return 12; }, close: async () => undefined }),
    };
    await expect(readCredentialFile(path, { trustedRoot: root, fileSystem: swapped, trustedOwnerIds: [0], serviceUid: 1000 }))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-CREDENTIAL" });
  });

  it("rejects Windows production mode without an injected ACL-verifying adapter", async () => {
    const root = "C:\\run\\secrets";
    const unverified: CredentialFileSystem = {
      platform: "windows-unverified",
      inspect: async () => { throw new Error("must not inspect"); },
      openNoFollow: async () => { throw new Error("must not open"); },
    };
    await expect(readCredentialFile("C:\\run\\secrets\\provider", { trustedRoot: root, fileSystem: unverified }))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-CREDENTIAL" });
  });

  it("preserves exact bigint identities above Number.MAX_SAFE_INTEGER with deterministic Windows metadata", async () => {
    const root = "C:\\run\\secrets";
    const path = "C:\\run\\secrets\\provider";
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + 123_456_789n;
    const directory: CredentialMetadata = { type: "directory", mode: 0, uid: 0, dev: huge, ino: huge + 1n, size: 0n, trustedAcl: true };
    const file: CredentialMetadata = { type: "file", mode: 0, uid: 0, dev: huge, ino: huge + 2n, size: 12n, trustedAcl: true };
    const fileSystem: CredentialFileSystem = {
      platform: "windows-verified",
      inspect: async (candidate) => candidate === path ? file : directory,
      openNoFollow: async () => ({
        inspect: async () => file,
        read: async (buffer) => { buffer.write("dummy-secret"); return 12; },
        close: async () => undefined,
      }),
    };

    for (let run = 0; run < 20; run += 1) {
      const credential = await readCredentialFile(path, { trustedRoot: root, fileSystem, maxBytes: 64 });
      expect(credential.toString("utf8")).toBe("dummy-secret");
      credential.fill(0);
    }

    const changedIdentity: CredentialFileSystem = {
      ...fileSystem,
      openNoFollow: async () => ({
        inspect: async () => ({ ...file, ino: file.ino + 1n }),
        read: async () => 0,
        close: async () => undefined,
      }),
    };
    await expect(readCredentialFile(path, { trustedRoot: root, fileSystem: changedIdentity, maxBytes: 64 }))
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
    const controller = new AbortController();
    const queued = limiter.acquire(1, controller.signal);
    controller.abort();
    await expect(queued).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-CANCELLED" });
    now = 60_000;
  });

  it("wakes FIFO bucket waiters on deterministic replenishment and cleans cancelled timers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const limiter = new ProfileRateLimiter({ maxConcurrency: 2, requestsPerMinute: 60, tokensPerMinute: 600 });
      const firstRelease = await limiter.acquire(600, new AbortController().signal);
      firstRelease();
      const order: string[] = [];
      const secondController = new AbortController();
      const removeAbortListener = vi.spyOn(secondController.signal, "removeEventListener");
      const firstWaiter = limiter.acquire(10, new AbortController().signal).then((release) => { order.push("first"); return release; });
      const secondWaiter = limiter.acquire(10, secondController.signal).then((release) => { order.push("second"); return release; });

      expect(order).toEqual([]);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      const releaseFirstWaiter = await firstWaiter;
      expect(order).toEqual(["first"]);
      releaseFirstWaiter();
      expect(vi.getTimerCount()).toBe(1);

      secondController.abort(new Error("cancel queued waiter"));
      await expect(secondWaiter).rejects.toMatchObject({ code: "OCC-AI-PROVIDER-CANCELLED" });
      expect(vi.getTimerCount()).toBe(0);
      expect(removeAbortListener).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      vi.useRealTimers();
    }
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

  it("does not let a hanging sleeper exceed the original deadline", async () => {
    const deadline = createOperationDeadline(20, new AbortController().signal);
    const operation = vi.fn(async () => { throw new ProviderError("OCC-AI-PROVIDER-TRANSIENT", true); });
    const startedAt = Date.now();
    const error = await executeWithRetry({ operationId: "op", deadline: deadline.expiresAt, signal: deadline.signal, sleep: async () => new Promise(() => undefined) }, operation).catch((caught: unknown) => caught);
    deadline.dispose();

    expect(error).toMatchObject({ code: "OCC-AI-PROVIDER-TIMEOUT" });
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("keeps 100/500ms backoff exact and uses Retry-After only to suppress impossible retries", async () => {
    const sleep = vi.fn(async () => undefined);
    let attempts = 0;
    await executeWithRetry({ operationId: "op", deadline: 10_000, now: () => 0, sleep }, async () => {
      attempts += 1;
      if (attempts === 1) throw new ProviderError("OCC-AI-PROVIDER-TRANSIENT", true, { retryAfterMs: 900 });
      if (attempts === 2) throw new ProviderError("OCC-AI-PROVIDER-TRANSIENT", true, { retryAfterMs: 50 });
      return "ok";
    });
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([100, 500]);

    const suppressed = vi.fn(async () => { throw new ProviderError("OCC-AI-PROVIDER-TRANSIENT", true, { retryAfterMs: 2_000 }); });
    await expect(executeWithRetry({ operationId: "op", deadline: 1_000, now: () => 0, sleep }, suppressed))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-TIMEOUT" });
    expect(suppressed).toHaveBeenCalledTimes(1);
  });

  it("does not start another attempt when the injected clock reaches the deadline during backoff", async () => {
    let now = 0;
    const operation = vi.fn(async () => { throw new ProviderError("OCC-AI-PROVIDER-TRANSIENT", true); });
    await expect(executeWithRetry({ operationId: "op", deadline: 500, now: () => now, sleep: async () => { now = 500; } }, operation))
      .rejects.toMatchObject({ code: "OCC-AI-PROVIDER-TIMEOUT" });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("uses validated usage or a deterministic conservative estimate without floating undercharge", () => {
    expect(calculateAccounting({ requestBytes: 8, responseBytes: 5, usage: { inputTokens: 2, outputTokens: 3 }, cost: { currency: "USD", inputMicrosPerMillionTokens: 500_001, outputMicrosPerMillionTokens: 1_000_001 } }))
      .toEqual({ inputTokens: 8, outputTokens: 5, costMicros: 11n, currency: "USD", estimated: true });
    expect(calculateAccounting({ requestBytes: 8, responseBytes: 5, usage: { inputTokens: 10, outputTokens: 7 }, cost: { currency: "USD", inputMicrosPerMillionTokens: 500_001, outputMicrosPerMillionTokens: 1_000_001 } }))
      .toEqual({ inputTokens: 10, outputTokens: 7, costMicros: 14n, currency: "USD", estimated: false });
    expect(calculateAccounting({ requestBytes: 8, responseBytes: 5, usage: { inputTokens: 0, outputTokens: 0 }, cost: { currency: "USD", inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 } }))
      .toEqual({ inputTokens: 8, outputTokens: 5, costMicros: 2n, currency: "USD", estimated: true });
    expect(calculateAccounting({ requestBytes: 8, responseBytes: 5, cost: { currency: "USD", inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 } }))
      .toEqual({ inputTokens: 8, outputTokens: 5, costMicros: 2n, currency: "USD", estimated: true });
    expect(() => calculateAccounting({ requestBytes: 1, responseBytes: 1, usage: { inputTokens: -1, outputTokens: 0 }, cost: { currency: "USD", inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 } })).toThrow();
  });
});
