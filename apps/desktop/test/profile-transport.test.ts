// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { createProfileTransport } from "../src/profile-transport";

const profile = { id: "9d564974-1f4f-4cc8-987a-4f2f09790d13", origin: "https://occ.example", caFingerprint: "AA".repeat(32) };

describe("profile-scoped Electron transport", () => {
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

  it("keeps A permanently pinned while a concurrent transition to B waits for A", async () => {
    let finishA!: () => void;
    const requestA = new Promise<Response>((resolve) => { finishA = () => resolve(new Response("A")); });
    const first = { setCertificateVerifyProc: vi.fn(), fetch: vi.fn(() => requestA), clearStorageData: vi.fn().mockResolvedValue(undefined) };
    const second = { setCertificateVerifyProc: vi.fn(), fetch: vi.fn().mockResolvedValue(new Response("B")), clearStorageData: vi.fn().mockResolvedValue(undefined) };
    const transport = createProfileTransport({ fromPartition: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second) });
    const pendingA = transport.fetch(profile, new URL("https://occ.example/a"));
    await vi.waitFor(() => expect(first.fetch).toHaveBeenCalledOnce());

    const profileB = { ...profile, id: "8e635134-d8a0-4bbf-8472-e8e44a0c66e2", origin: "https://b.example" };
    const pendingB = transport.fetch(profileB, new URL("https://b.example/b"));
    await Promise.resolve();
    expect(first.setCertificateVerifyProc).not.toHaveBeenCalledWith(null);
    expect(first.clearStorageData).not.toHaveBeenCalled();
    expect(second.setCertificateVerifyProc).toHaveBeenCalledOnce();
    expect(second.fetch).not.toHaveBeenCalled();

    finishA();
    await expect(pendingA).resolves.toBeInstanceOf(Response);
    await expect(pendingB).resolves.toBeInstanceOf(Response);
    expect(first.clearStorageData).toHaveBeenCalledOnce();
    expect(first.setCertificateVerifyProc).not.toHaveBeenCalledWith(null);
  });

  it("is wired into production CoreClient instead of global fetch", () => {
    const main = readFileSync(path.resolve(__dirname, "../src/main.ts"), "utf8");
    expect(main).toContain("createProfileTransport");
    expect(main).toContain("session.fromPartition");
    expect(main).toMatch(/createCoreClient\([\s\S]+profileTransport\.fetch/);
    expect(main).not.toMatch(/createCoreClient\(\{\s*fetch,/);
  });
});
