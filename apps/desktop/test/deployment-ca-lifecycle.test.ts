// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { handleDeploymentCaLifecycle } from "../src/deployment-ca-lifecycle";

describe("bounded Squirrel deployment CA lifecycle", () => {
  it("is a no-op when a complete deployment payload and confirmation are absent", async () => {
    const invoke = vi.fn();
    await expect(handleDeploymentCaLifecycle({ argv: ["app.exe", "--squirrel-install"], resourcesPath: "C:\\app\\resources", userData: "C:\\userData", execPath: "C:\\app\\InnorderOCC.exe" }, { exists: async () => false, read: vi.fn(), invoke })).resolves.toEqual({ handled: true, status: "no-payload" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("invokes only the fixed bundled helper contract for install and removal", async () => {
    const invoke = vi.fn().mockResolvedValue({ status: "unavailable", reason: "AUTHENTICODE_REQUIRED" });
    const exists = vi.fn().mockResolvedValue(true);
    const read = vi.fn().mockResolvedValue(Buffer.from(JSON.stringify({ version: 1, productId: "com.innorder.occ", deploymentId: "9d564974-1f4f-4cc8-987a-4f2f09790d13", confirmed: true, certificateManifestSha256: "aa".repeat(32), caFingerprint: "BB".repeat(32) })));
    await handleDeploymentCaLifecycle({ argv: ["app.exe", "--squirrel-install"], resourcesPath: "C:\\app\\resources", userData: "C:\\userData", execPath: "C:\\app\\InnorderOCC.exe" }, { exists, read, invoke });
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ script: "C:\\app\\resources\\enroll-deployment-ca.ps1", mode: "enroll" }));
    expect(invoke.mock.calls[0]?.[0].arguments).toEqual(expect.arrayContaining(["-ExpectedManifestSha256", "AA".repeat(32), "-ExpectedFingerprint", "BB".repeat(32)]));
    expect(JSON.stringify(invoke.mock.calls)).not.toMatch(/Invoke-Expression|Start-Process/);
  });

  it("rejects malformed confirmation without invoking a helper", async () => {
    const invoke = vi.fn();
    await expect(handleDeploymentCaLifecycle({ argv: ["app.exe", "--squirrel-install"], resourcesPath: "C:\\app\\resources", userData: "C:\\userData", execPath: "C:\\app\\InnorderOCC.exe" }, {
      exists: async () => true,
      read: async () => Buffer.from('{"confirmed":true,"extra":true}'),
      invoke,
    })).resolves.toEqual({ handled: true, status: "invalid-payload" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("is invoked by main only for the fixed packaged lifecycle contract", () => {
    const main = readFileSync(path.resolve(__dirname, "../src/main.ts"), "utf8");
    expect(main).toContain("handleDeploymentCaLifecycle");
    expect(main).toContain("process.resourcesPath");
    expect(main).toContain("execFile");
    expect(main).not.toMatch(/exec\(|shell:\s*true|Invoke-Expression/);
  });
});
