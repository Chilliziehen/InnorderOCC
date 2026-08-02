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
    expect(fromPartition).toHaveBeenCalledWith(`persist:occ-profile-${profile.id}`);
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
    expect(first.setCertificateVerifyProc).toHaveBeenLastCalledWith(null);
    expect(first.clearStorageData).toHaveBeenCalledOnce();
  });

  it("is wired into production CoreClient instead of global fetch", () => {
    const main = readFileSync(path.resolve(__dirname, "../src/main.ts"), "utf8");
    expect(main).toContain("createProfileTransport");
    expect(main).toContain("session.fromPartition");
    expect(main).toMatch(/createCoreClient\([\s\S]+profileTransport\.fetch/);
    expect(main).not.toMatch(/createCoreClient\(\{\s*fetch,/);
  });
});
