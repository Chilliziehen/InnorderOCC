// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { handleDeploymentCaLifecycle } from "../src/deployment-ca-lifecycle";

describe("bounded Squirrel deployment CA lifecycle", () => {
  const verifiedRelease = {
    releaseManifest: {
      productVersion: "0.1.0",
      publisher: { subject: "CN=Innorder Release", thumbprint: "AB".repeat(20) },
    },
  };

  it("is a no-op when a complete deployment payload and confirmation are absent", async () => {
    const invoke = vi.fn();
    await expect(handleDeploymentCaLifecycle({ argv: ["app.exe", "--squirrel-install"], resourcesPath: "C:\\app\\resources", userData: "C:\\userData", execPath: "C:\\app\\InnorderOCC.exe" }, { exists: async () => false, read: vi.fn(), verify: vi.fn(), preflight: vi.fn(), invoke })).resolves.toEqual({ handled: true, status: "no-payload" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("verifies the trusted bundle and publisher before invoking the fixed helper", async () => {
    const order: string[] = [];
    const verify = vi.fn(async () => { order.push("verify"); return verifiedRelease; });
    const preflight = vi.fn(async () => { order.push("preflight"); });
    const invoke = vi.fn().mockResolvedValue({ status: "unavailable", reason: "AUTHENTICODE_REQUIRED" });
    invoke.mockImplementation(async () => { order.push("invoke"); });
    const exists = vi.fn().mockResolvedValue(true);
    const read = vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({ version: 1, productId: "com.innorder.occ", deploymentId: "9d564974-1f4f-4cc8-987a-4f2f09790d13", confirmed: true, certificateManifestSha256: "aa".repeat(32), caFingerprint: "BB".repeat(32) })));
    await handleDeploymentCaLifecycle({ argv: ["app.exe", "--squirrel-install"], resourcesPath: "C:\\app\\resources", userData: "C:\\userData", execPath: "C:\\app\\InnorderOCC.exe" }, { exists, read, verify, preflight, invoke });
    expect(order).toEqual(["verify", "preflight", "invoke"]);
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({
      purpose: "enroll",
      certificateManifestPath: "C:\\app\\resources\\deployment-ca\\certificate-manifest.json",
      releaseManifestPath: "C:\\app\\resources\\deployment-ca\\release-manifest.json",
      enrollmentHelperPath: "C:\\app\\resources\\enroll-deployment-ca.ps1",
      removalHelperPath: "C:\\app\\resources\\remove-deployment-ca.ps1",
      installerPath: "C:\\app\\InnorderOCC.exe",
      expectedCertificateManifestSha256: "AA".repeat(32),
    }));
    expect(preflight).toHaveBeenCalledWith(expect.objectContaining({ helperPath: "C:\\app\\resources\\enroll-deployment-ca.ps1", publisherSubject: "CN=Innorder Release", publisherThumbprint: "AB".repeat(20) }));
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ script: "C:\\app\\resources\\enroll-deployment-ca.ps1", mode: "enroll" }));
    expect(invoke.mock.calls[0]?.[0].arguments).toEqual(expect.arrayContaining(["-ExpectedManifestSha256", "AA".repeat(32), "-ExpectedFingerprint", "BB".repeat(32)]));
    expect(JSON.stringify(invoke.mock.calls)).not.toMatch(/Invoke-Expression|Start-Process/);
  });

  it("uses removal-purpose verification before an owned uninstall helper", async () => {
    const verify = vi.fn(async () => verifiedRelease);
    const preflight = vi.fn().mockResolvedValue(undefined);
    const invoke = vi.fn().mockResolvedValue(undefined);
    const confirmation = Buffer.from(JSON.stringify({ version: 1, productId: "com.innorder.occ", deploymentId: "9d564974-1f4f-4cc8-987a-4f2f09790d13", confirmed: true, certificateManifestSha256: "aa".repeat(32), caFingerprint: "BB".repeat(32) }));
    await expect(handleDeploymentCaLifecycle({ argv: ["app.exe", "--squirrel-uninstall"], resourcesPath: "C:\\app\\resources", userData: "C:\\userData", execPath: "C:\\app\\InnorderOCC.exe" }, {
      exists: async () => true,
      read: async () => confirmation,
      verify,
      preflight,
      invoke,
    })).resolves.toEqual({ handled: true, status: "invoked" });
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ purpose: "remove" }));
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ mode: "remove" }));
  });

  it("makes zero process calls when trusted bundle verification detects a modified artifact", async () => {
    const preflight = vi.fn();
    const invoke = vi.fn();
    const confirmation = Buffer.from(JSON.stringify({ version: 1, productId: "com.innorder.occ", deploymentId: "9d564974-1f4f-4cc8-987a-4f2f09790d13", confirmed: true, certificateManifestSha256: "aa".repeat(32), caFingerprint: "BB".repeat(32) }));
    await expect(handleDeploymentCaLifecycle({ argv: ["app.exe", "--squirrel-install"], resourcesPath: "C:\\app\\resources", userData: "C:\\userData", execPath: "C:\\app\\InnorderOCC.exe" }, {
      exists: async () => true,
      read: async () => confirmation,
      verify: async () => { throw new Error("Enrollment helper SHA-256 mismatch"); },
      preflight,
      invoke,
    })).resolves.toEqual({ handled: true, status: "invalid-payload" });
    expect(preflight).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects malformed confirmation without invoking a helper", async () => {
    const invoke = vi.fn();
    await expect(handleDeploymentCaLifecycle({ argv: ["app.exe", "--squirrel-install"], resourcesPath: "C:\\app\\resources", userData: "C:\\userData", execPath: "C:\\app\\InnorderOCC.exe" }, {
      exists: async () => true,
      read: async () => Buffer.from('{"confirmed":true,"extra":true}'),
      verify: vi.fn(),
      preflight: vi.fn(),
      invoke,
    })).resolves.toEqual({ handled: true, status: "invalid-payload" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("is invoked by main only for the fixed packaged lifecycle contract", () => {
    const main = readFileSync(path.resolve(__dirname, "../src/main.ts"), "utf8");
    expect(main).toContain("handleDeploymentCaLifecycle");
    expect(main).toContain("verifyProductionDeploymentReleaseBundle");
    expect(main).toContain("process.resourcesPath");
    expect(main).toContain("execFile");
    expect(main).not.toMatch(/exec\(|shell:\s*true|Invoke-Expression|ExecutionPolicy|Bypass/);
  });
});
