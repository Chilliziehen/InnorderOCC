// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { createProfileTransport } from "../src/profile-transport";

const profile = { id: "9d564974-1f4f-4cc8-987a-4f2f09790d13", origin: "https://occ.example", caFingerprint: "AA".repeat(32) };

describe("profile-scoped Electron transport", () => {
  afterEach(() => vi.useRealTimers());
  it("uses a profile partition and delegates only an exact system-valid chain to Chromium", async () => {
    const setCertificateVerifyProc = vi.fn();
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    const clearStorageData = vi.fn().mockResolvedValue(undefined);
    const fromPartition = vi.fn(() => ({ setCertificateVerifyProc, fetch, clearStorageData }));
    const transport = createProfileTransport({ fromPartition });
    await transport.fetch(profile, new URL("https://occ.example/api"), {});
    expect(fromPartition).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^persist:occ-profile-${profile.id}-[0-9a-f]{64}$`)));
    expect(fetch).toHaveBeenCalledOnce();

    const verifier = setCertificateVerifyProc.mock.calls[0]?.[0];
    const callback = vi.fn();
    verifier({ hostname: "occ.example", verificationResult: "net::OK", errorCode: 0, certificate: { fingerprint: "11".repeat(32), issuerCert: { fingerprint: "AA".repeat(32) } } }, callback);
    expect(callback).toHaveBeenCalledWith(-3);
  });

  it.each([
    ["wrong host", { hostname: "wrong.example", verificationResult: "net::OK", errorCode: 0, certificate: { fingerprint: "11".repeat(32), issuerCert: { fingerprint: "AA".repeat(32) } } }],
    ["expired/untrusted", { hostname: "occ.example", verificationResult: "net::ERR_CERT_DATE_INVALID", errorCode: -201, certificate: { fingerprint: "11".repeat(32), issuerCert: { fingerprint: "AA".repeat(32) } } }],
    ["replaced CA", { hostname: "occ.example", verificationResult: "net::OK", errorCode: 0, certificate: { fingerprint: "11".repeat(32), issuerCert: { fingerprint: "BB".repeat(32) } } }],
  ])("fails closed for %s", async (_case, request) => {
    const setCertificateVerifyProc = vi.fn();
    const transport = createProfileTransport({ fromPartition: () => ({ setCertificateVerifyProc, fetch: vi.fn(), clearStorageData: vi.fn() }) });
    await expect(transport.setProfile(profile)).resolves.toBeUndefined();
    const callback = vi.fn();
    setCertificateVerifyProc.mock.calls[0]?.[0](request, callback);
    expect(callback).toHaveBeenCalledWith(-2);
  });

  it("uses an explicitly injected build verifier without changing the default fail-closed policy", async () => {
    const setCertificateVerifyProc = vi.fn();
    const verifyCertificate = vi.fn().mockReturnValue(true);
    const transport = createProfileTransport({
      fromPartition: () => ({ setCertificateVerifyProc, fetch: vi.fn(), clearStorageData: vi.fn() }),
      verifyCertificate,
    });
    await transport.setProfile(profile);
    const request = { hostname: "occ.example", verificationResult: "net::ERR_CERT_AUTHORITY_INVALID", errorCode: -202, certificate: { fingerprint: "AA".repeat(32) } };
    const callback = vi.fn();
    setCertificateVerifyProc.mock.calls[0]?.[0](request, callback);
    expect(verifyCertificate).toHaveBeenCalledWith(profile, request);
    expect(callback).toHaveBeenCalledWith(-3);
  });

  it("preserves exact Chromium system verification for profiles without a private CA pin", async () => {
    const setCertificateVerifyProc = vi.fn();
    const transport = createProfileTransport({ fromPartition: () => ({ setCertificateVerifyProc, fetch: vi.fn(), clearStorageData: vi.fn() }) });
    await transport.setProfile({ ...profile, caFingerprint: undefined });
    const callback = vi.fn();
    setCertificateVerifyProc.mock.calls[0]?.[0]({ hostname: "occ.example", verificationResult: "net::OK", errorCode: 0, certificate: { fingerprint: "11".repeat(32) } }, callback);
    expect(callback).toHaveBeenCalledWith(-3);
  });

  it("clears the prior verifier and storage when the selected profile changes", async () => {
    const first = { setCertificateVerifyProc: vi.fn(), fetch: vi.fn(), clearStorageData: vi.fn().mockResolvedValue(undefined) };
    const second = { setCertificateVerifyProc: vi.fn(), fetch: vi.fn(), clearStorageData: vi.fn().mockResolvedValue(undefined) };
    const fromPartition = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const transport = createProfileTransport({ fromPartition });
    await transport.setProfile(profile);
    await transport.setProfile({ ...profile, id: "8e635134-d8a0-4bbf-8472-e8e44a0c66e2" });
    expect(first.setCertificateVerifyProc).not.toHaveBeenCalledWith(null);
    expect(first.clearStorageData).toHaveBeenCalledOnce();
  });

  it("starts pinned B immediately while retired A drains independently", async () => {
    let finishA!: () => void;
    const requestA = new Promise<Response>((resolve) => { finishA = () => resolve(new Response("A")); });
    const first = { setCertificateVerifyProc: vi.fn(), fetch: vi.fn(() => requestA), clearStorageData: vi.fn().mockResolvedValue(undefined) };
    const second = { setCertificateVerifyProc: vi.fn(), fetch: vi.fn().mockResolvedValue(new Response("B")), clearStorageData: vi.fn().mockResolvedValue(undefined) };
    const transport = createProfileTransport({ fromPartition: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second) });
    const pendingA = transport.fetch(profile, new URL("https://occ.example/a"));
    await vi.waitFor(() => expect(first.fetch).toHaveBeenCalledOnce());

    const profileB = { ...profile, id: "8e635134-d8a0-4bbf-8472-e8e44a0c66e2", origin: "https://b.example" };
    const pendingB = transport.fetch(profileB, new URL("https://b.example/b"));
    await expect(pendingB).resolves.toBeInstanceOf(Response);
    expect(first.setCertificateVerifyProc).not.toHaveBeenCalledWith(null);
    expect(first.clearStorageData).not.toHaveBeenCalled();
    expect(second.setCertificateVerifyProc).toHaveBeenCalledOnce();
    expect(second.fetch).toHaveBeenCalledOnce();

    finishA();
    const responseA = await pendingA;
    await expect(responseA.text()).resolves.toBe("A");
    await vi.waitFor(() => expect(first.clearStorageData).toHaveBeenCalledOnce());
    expect(first.setCertificateVerifyProc).not.toHaveBeenCalledWith(null);
  });

  it("does not deadlock A to B to A and gives each activation an immutable partition", async () => {
    let finishA1!: () => void;
    let finishB!: () => void;
    const first = {
      setCertificateVerifyProc: vi.fn(),
      fetch: vi.fn(() => new Promise<Response>((resolve) => { finishA1 = () => resolve(new Response("A1")); })),
      clearStorageData: vi.fn().mockResolvedValue(undefined),
    };
    const second = {
      setCertificateVerifyProc: vi.fn(),
      fetch: vi.fn(() => new Promise<Response>((resolve) => { finishB = () => resolve(new Response("B")); })),
      clearStorageData: vi.fn().mockResolvedValue(undefined),
    };
    const third = { setCertificateVerifyProc: vi.fn(), fetch: vi.fn().mockResolvedValue(new Response("A2")), clearStorageData: vi.fn().mockResolvedValue(undefined) };
    const fromPartition = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second).mockReturnValueOnce(third);
    const transport = createProfileTransport({ fromPartition });
    const profileB = { ...profile, id: "8e635134-d8a0-4bbf-8472-e8e44a0c66e2", origin: "https://b.example" };
    const pendingA1 = transport.fetch(profile, new URL("https://occ.example/a1"));
    await vi.waitFor(() => expect(first.fetch).toHaveBeenCalledOnce());
    const pendingB = transport.fetch(profileB, new URL("https://b.example/b"));
    await vi.waitFor(() => expect(second.fetch).toHaveBeenCalledOnce());
    await expect(transport.fetch(profile, new URL("https://occ.example/a2"))).resolves.toBeInstanceOf(Response);
    expect(first.fetch).toHaveBeenCalledOnce();
    expect(third.fetch).toHaveBeenCalledOnce();
    expect(new Set(fromPartition.mock.calls.map(([partition]) => partition)).size).toBe(3);
    finishB();
    finishA1();
    await Promise.all([pendingA1, pendingB]);
    expect(first.setCertificateVerifyProc).not.toHaveBeenCalledWith(null);
    expect(second.setCertificateVerifyProc).not.toHaveBeenCalledWith(null);
  });

  it("does not reuse a partition generation when the transport is recreated", async () => {
    const partitions: string[] = [];
    const fromPartition = (partition: string) => {
      partitions.push(partition);
      return { setCertificateVerifyProc: vi.fn(), fetch: vi.fn().mockResolvedValue(new Response("A")), clearStorageData: vi.fn().mockResolvedValue(undefined) };
    };
    await createProfileTransport({ fromPartition }).fetch(profile, new URL("https://occ.example/a"));
    await createProfileTransport({ fromPartition }).fetch(profile, new URL("https://occ.example/a"));
    expect(new Set(partitions).size).toBe(2);
  });

  it("combines the caller signal with a binding-owned abort signal", async () => {
    const caller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const session = {
      setCertificateVerifyProc: vi.fn(),
      fetch: vi.fn((_input: URL, init?: RequestInit) => { receivedSignal = init?.signal ?? undefined; return Promise.resolve(new Response("A")); }),
      clearStorageData: vi.fn().mockResolvedValue(undefined),
    };
    const transport = createProfileTransport({ fromPartition: () => session });
    await transport.fetch(profile, new URL("https://occ.example/a"), { signal: caller.signal });
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).not.toBe(caller.signal);
    caller.abort(new Error("caller cancelled"));
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("aborts retired requests waiting for headers without affecting the current binding", async () => {
    vi.useFakeTimers();
    const signals: Array<AbortSignal | undefined> = [];
    const pendingFetch = vi.fn((_input: URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal ?? undefined;
      signals.push(signal);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const sessions = [0, 1].map(() => ({ setCertificateVerifyProc: vi.fn(), fetch: pendingFetch, clearStorageData: vi.fn().mockResolvedValue(undefined) }));
    const transport = createProfileTransport({ fromPartition: vi.fn().mockReturnValueOnce(sessions[0]).mockReturnValueOnce(sessions[1]), retiredTimeoutMs: 1_000 });
    const requestA = transport.fetch(profile, new URL("https://occ.example/a"));
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const profileB = { ...profile, id: "8e635134-d8a0-4bbf-8472-e8e44a0c66e2", origin: "https://b.example" };
    void transport.fetch(profileB, new URL("https://b.example/b"));
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    const rejected = expect(requestA).rejects.toThrow(/retired/i);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    await rejected;
  });

  it("forces expiry of the oldest pending-header binding when the retired limit overflows", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const sessions = [0, 1, 2].map(() => ({
      setCertificateVerifyProc: vi.fn(),
      fetch: vi.fn((_input: URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal ?? undefined;
        signals.push(signal);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      })),
      clearStorageData: vi.fn().mockResolvedValue(undefined),
    }));
    const transport = createProfileTransport({ fromPartition: vi.fn().mockReturnValueOnce(sessions[0]).mockReturnValueOnce(sessions[1]).mockReturnValueOnce(sessions[2]), retiredTimeoutMs: 60_000, maxRetiredBindings: 1 });
    const requestA = transport.fetch(profile, new URL("https://occ.example/a"));
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    const profileB = { ...profile, id: "8e635134-d8a0-4bbf-8472-e8e44a0c66e2", origin: "https://b.example" };
    void transport.fetch(profileB, new URL("https://b.example/b"));
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    const profileC = { ...profile, id: "7a597dde-f073-4cc8-b5ce-6e6f60bb69b3", origin: "https://c.example" };
    const rejectedA = expect(requestA).rejects.toThrow(/retired/i);
    void transport.fetch(profileC, new URL("https://c.example/c"));
    expect(signals[0]?.aborted).toBe(true);
    await rejectedA;
    expect(signals.map((signal) => signal?.aborted)).toEqual([true, false, false]);
  });

  it("cancels and rejects a response that arrives after its binding expires", async () => {
    vi.useFakeTimers();
    let resolveHeaders!: (response: Response) => void;
    let receivedSignal: AbortSignal | undefined;
    const cancelLateBody = vi.fn().mockResolvedValue(undefined);
    const first = {
      setCertificateVerifyProc: vi.fn(),
      fetch: vi.fn((_input: URL, init?: RequestInit) => {
        receivedSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => { resolveHeaders = resolve; });
      }),
      clearStorageData: vi.fn().mockResolvedValue(undefined),
    };
    const second = { setCertificateVerifyProc: vi.fn(), fetch: vi.fn().mockResolvedValue(new Response("B")), clearStorageData: vi.fn().mockResolvedValue(undefined) };
    const transport = createProfileTransport({ fromPartition: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second), retiredTimeoutMs: 1_000 });
    const request = transport.fetch(profile, new URL("https://occ.example/a"));
    await vi.waitFor(() => expect(first.fetch).toHaveBeenCalledOnce());
    const profileB = { ...profile, id: "8e635134-d8a0-4bbf-8472-e8e44a0c66e2", origin: "https://b.example" };
    await transport.fetch(profileB, new URL("https://b.example/b"));
    await vi.advanceTimersByTimeAsync(1_000);
    resolveHeaders(new Response(new ReadableStream<Uint8Array>({ cancel: cancelLateBody })));
    await expect(request).rejects.toThrow(/retired/i);
    expect(receivedSignal?.aborted).toBe(true);
    expect(cancelLateBody).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(first.clearStorageData).toHaveBeenCalledOnce());
  });

  it("keeps a retired request pinned until its streaming body reaches EOF", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const first = {
      setCertificateVerifyProc: vi.fn(),
      fetch: vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } }))),
      clearStorageData: vi.fn().mockResolvedValue(undefined),
    };
    const second = { setCertificateVerifyProc: vi.fn(), fetch: vi.fn().mockResolvedValue(new Response("B")), clearStorageData: vi.fn().mockResolvedValue(undefined) };
    const third = { setCertificateVerifyProc: vi.fn(), fetch: vi.fn().mockResolvedValue(new Response("A2")), clearStorageData: vi.fn().mockResolvedValue(undefined) };
    const transport = createProfileTransport({ fromPartition: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second).mockReturnValueOnce(third) });
    const responseA = await transport.fetch(profile, new URL("https://occ.example/a"));
    const profileB = { ...profile, id: "8e635134-d8a0-4bbf-8472-e8e44a0c66e2", origin: "https://b.example" };
    await transport.fetch(profileB, new URL("https://b.example/b"));
    await transport.fetch(profile, new URL("https://occ.example/a2"));
    expect(first.clearStorageData).not.toHaveBeenCalled();
    const body = responseA.text();
    streamController.enqueue(new TextEncoder().encode("A"));
    streamController.close();
    await expect(body).resolves.toBe("A");
    await vi.waitFor(() => expect(first.clearStorageData).toHaveBeenCalledOnce());
  });

  it("expires only retired streaming bodies and rejects subsequent reads", async () => {
    vi.useFakeTimers();
    const cancelA = vi.fn().mockResolvedValue(undefined);
    const cancelB = vi.fn().mockResolvedValue(undefined);
    const stream = (cancel: ReturnType<typeof vi.fn>) => new ReadableStream<Uint8Array>({ pull() { return new Promise(() => undefined); }, cancel });
    const first = { setCertificateVerifyProc: vi.fn(), fetch: vi.fn().mockResolvedValue(new Response(stream(cancelA))), clearStorageData: vi.fn().mockResolvedValue(undefined) };
    const second = { setCertificateVerifyProc: vi.fn(), fetch: vi.fn().mockResolvedValue(new Response(stream(cancelB))), clearStorageData: vi.fn().mockResolvedValue(undefined) };
    const transport = createProfileTransport({
      fromPartition: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second),
      retiredTimeoutMs: 1_000,
      maxRetiredBindings: 2,
    });
    const responseA = await transport.fetch(profile, new URL("https://occ.example/a"));
    const readA = responseA.body!.getReader().read();
    const profileB = { ...profile, id: "8e635134-d8a0-4bbf-8472-e8e44a0c66e2", origin: "https://b.example" };
    const responseB = await transport.fetch(profileB, new URL("https://b.example/b"));
    const readB = responseB.body!.getReader().read();
    const retiredRead = expect(readA).rejects.toThrow(/retired/i);
    await vi.advanceTimersByTimeAsync(1_000);
    await retiredRead;
    expect(cancelA).toHaveBeenCalledOnce();
    expect(cancelB).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(first.clearStorageData).toHaveBeenCalledOnce());
    let settledB = false;
    void readB.finally(() => { settledB = true; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settledB).toBe(false);
  });

  it("clears an expired retired binding even when stream cancellation never settles", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const first = {
      setCertificateVerifyProc: vi.fn(),
      fetch: vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ pull() { return new Promise(() => undefined); }, cancel }))),
      clearStorageData: vi.fn().mockResolvedValue(undefined),
    };
    const second = { setCertificateVerifyProc: vi.fn(), fetch: vi.fn().mockResolvedValue(new Response("B")), clearStorageData: vi.fn().mockResolvedValue(undefined) };
    const transport = createProfileTransport({ fromPartition: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second), retiredTimeoutMs: 1_000 });
    const response = await transport.fetch(profile, new URL("https://occ.example/a"));
    const read = response.body!.getReader().read();
    const profileB = { ...profile, id: "8e635134-d8a0-4bbf-8472-e8e44a0c66e2", origin: "https://b.example" };
    await transport.fetch(profileB, new URL("https://b.example/b"));
    const rejected = expect(read).rejects.toThrow(/retired/i);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(first.clearStorageData).toHaveBeenCalledOnce());
  });

  it("expires only the oldest overflow when retired bindings exceed the bound", async () => {
    const cancellations = [vi.fn().mockResolvedValue(undefined), vi.fn().mockResolvedValue(undefined), vi.fn().mockResolvedValue(undefined)];
    const sessions = cancellations.map((cancel) => ({
      setCertificateVerifyProc: vi.fn(),
      fetch: vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ pull() { return new Promise(() => undefined); }, cancel }))),
      clearStorageData: vi.fn().mockResolvedValue(undefined),
    }));
    const transport = createProfileTransport({ fromPartition: vi.fn().mockReturnValueOnce(sessions[0]).mockReturnValueOnce(sessions[1]).mockReturnValueOnce(sessions[2]), retiredTimeoutMs: 60_000, maxRetiredBindings: 1 });
    const profileB = { ...profile, id: "8e635134-d8a0-4bbf-8472-e8e44a0c66e2", origin: "https://b.example" };
    const profileC = { ...profile, id: "7a597dde-f073-4cc8-b5ce-6e6f60bb69b3", origin: "https://c.example" };
    const responseA = await transport.fetch(profile, new URL("https://occ.example/a"));
    const readA = responseA.body!.getReader().read();
    const rejectedA = expect(readA).rejects.toThrow(/retired/i);
    const responseB = await transport.fetch(profileB, new URL("https://b.example/b"));
    void responseB.body!.getReader().read();
    await transport.fetch(profileC, new URL("https://c.example/c"));
    await rejectedA;
    expect(cancellations[0]).toHaveBeenCalledOnce();
    expect(cancellations[1]).not.toHaveBeenCalled();
    expect(cancellations[2]).not.toHaveBeenCalled();
  }, 2_000);

  it("contains asynchronous retired-session cleanup errors", async () => {
    const first = { setCertificateVerifyProc: vi.fn(), fetch: vi.fn(), clearStorageData: vi.fn().mockRejectedValue(new Error("cleanup failed")) };
    const second = { setCertificateVerifyProc: vi.fn(), fetch: vi.fn().mockResolvedValue(new Response("B")), clearStorageData: vi.fn().mockResolvedValue(undefined) };
    const transport = createProfileTransport({ fromPartition: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second) });
    await transport.setProfile(profile);
    await expect(transport.setProfile({ ...profile, id: "8e635134-d8a0-4bbf-8472-e8e44a0c66e2", origin: "https://b.example" })).resolves.toBeUndefined();
    await expect(transport.fetch({ ...profile, id: "8e635134-d8a0-4bbf-8472-e8e44a0c66e2", origin: "https://b.example" }, new URL("https://b.example/b"))).resolves.toBeInstanceOf(Response);
  });

  it("is wired into production CoreClient instead of global fetch", () => {
    const main = readFileSync(path.resolve(__dirname, "../src/main.ts"), "utf8");
    expect(main).toContain("createProfileTransport");
    expect(main).toContain("session.fromPartition");
    expect(main).toMatch(/createCoreClient\([\s\S]+profileTransport\.fetch/);
    expect(main).not.toMatch(/createCoreClient\(\{\s*fetch,/);
  });
});
