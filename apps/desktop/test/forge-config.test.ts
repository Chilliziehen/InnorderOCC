// @vitest-environment node

import { existsSync, readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { describe, expect, it, vi } from "vitest";

import config from "../forge.config";
import mainViteConfig from "../vite.main.config";
import preloadViteConfig from "../vite.preload.config";
import rendererViteConfig from "../vite.renderer.config";

const desktopRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "../..");
const packageJson = JSON.parse(readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
const rootPackageJson = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));

type RuntimeForgeComponent = {
  name?: string;
  config?: Record<string, unknown>;
  fusesConfig?: Record<string, unknown>;
  platforms?: string[];
  prepareConfig?: (arch: string) => Promise<void>;
};

function parseIco(file: Buffer) {
  expect(file.readUInt16LE(0)).toBe(0);
  expect(file.readUInt16LE(2)).toBe(1);
  const count = file.readUInt16LE(4);

  return Array.from({ length: count }, (_, index) => {
    const entryOffset = 6 + index * 16;
    const width = file[entryOffset] || 256;
    const height = file[entryOffset + 1] || 256;
    const byteLength = file.readUInt32LE(entryOffset + 8);
    const imageOffset = file.readUInt32LE(entryOffset + 12);
    const dib = file.subarray(imageOffset, imageOffset + byteLength);

    expect(imageOffset + byteLength).toBeLessThanOrEqual(file.length);
    expect(dib.readUInt32LE(0)).toBe(40);
    expect(dib.readInt32LE(4)).toBe(width);
    expect(dib.readInt32LE(8)).toBe(height * 2);
    expect(dib.readUInt16LE(14)).toBe(32);

    return { width, height, pixels: dib.subarray(40, 40 + width * height * 4) };
  });
}

describe("Windows package configuration", () => {
  it("defines stable product, executable, publisher, version, and application identity", () => {
    expect(packageJson).toMatchObject({
      version: "0.1.0",
      productName: "Innorder OCC",
      description: "Innorder OCC 运营控制中心 / Operations Control Center",
      author: "Innorder",
      copyright: "Copyright (c) 2026 Innorder",
    });
    expect(config.packagerConfig).toMatchObject({
      asar: true,
      name: "Innorder OCC",
      executableName: "InnorderOCC",
      appBundleId: "com.innorder.occ",
      icon: path.join("assets", "occ.ico"),
      win32metadata: {
        CompanyName: "Innorder",
        FileDescription: "Innorder OCC 运营控制中心 / Operations Control Center",
        InternalName: "InnorderOCC",
        OriginalFilename: "InnorderOCC.exe",
        ProductName: "Innorder OCC",
      },
    });
    const mainSource = readFileSync(path.join(desktopRoot, "src", "main.ts"), "utf8");
    expect(mainSource).toContain('app.setAppUserModelId("com.innorder.occ")');
  });

  it("configures exactly one unsigned-development x64 Squirrel maker with local branding", async () => {
    const makers = config.makers ?? [];
    expect(makers).toHaveLength(1);
    const maker = makers[0] as RuntimeForgeComponent;
    await maker.prepareConfig?.("x64");

    expect(maker.name).toBe("squirrel");
    expect(maker.platforms).toEqual(["win32"]);
    expect(maker.config).toMatchObject({
      name: "com.innorder.occ",
      authors: "Innorder",
      title: "Innorder OCC",
      exe: "InnorderOCC.exe",
      setupExe: "InnorderOCC-0.1.0-x64-unsigned-dev-Setup.exe",
      setupIcon: path.resolve(desktopRoot, "assets", "occ.ico"),
      nuspecTemplate: path.resolve(desktopRoot, "assets", "squirrel.nuspectemplate"),
      noMsi: true,
    });
    expect(maker.config?.iconUrl).toBeUndefined();
    const nuspecTemplate = readFileSync(String(maker.config?.nuspecTemplate), "utf8");
    expect(nuspecTemplate).not.toMatch(/iconUrl|electron\.ico/i);
    expect(JSON.stringify(maker.config)).not.toMatch(/certificate|password|remoteToken|windowsSign/i);
    expect(packageJson.devDependencies).toMatchObject({
      "@electron-forge/maker-squirrel": "8.0.0-alpha.10",
      "@electron-forge/plugin-fuses": "8.0.0-alpha.10",
      "@electron/fuses": "2.1.3",
    });
    const lock = JSON.parse(readFileSync(path.join(repositoryRoot, "package-lock.json"), "utf8"));
    for (const dependency of [
      "node_modules/@electron-forge/maker-squirrel",
      "node_modules/@electron-forge/plugin-fuses",
      "node_modules/@electron/fuses",
    ]) {
      expect(new URL(lock.packages[dependency].resolved).hostname).toBe("registry.npmjs.org");
    }
  });

  it("hardens the packaged executable with the compatible Electron fuses", () => {
    const fuses = (config.plugins as RuntimeForgeComponent[]).find((plugin) => plugin.name === "fuses");

    expect(fuses?.fusesConfig?.version).toBe(FuseVersion.V1);
    expect(fuses?.fusesConfig?.[FuseV1Options.RunAsNode]).toBe(false);
    expect(fuses?.fusesConfig?.[FuseV1Options.EnableCookieEncryption]).toBe(true);
    expect(fuses?.fusesConfig?.[FuseV1Options.EnableNodeOptionsEnvironmentVariable]).toBe(false);
    expect(fuses?.fusesConfig?.[FuseV1Options.EnableNodeCliInspectArguments]).toBe(false);
    expect(fuses?.fusesConfig?.[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]).toBe(true);
    expect(fuses?.fusesConfig?.[FuseV1Options.OnlyLoadAppFromAsar]).toBe(true);
  });

  it("ships all required reviewed bitmap icon layers and brand colors", () => {
    const iconPath = path.join(desktopRoot, "assets", "occ.ico");
    expect(existsSync(iconPath)).toBe(true);
    const layers = parseIco(readFileSync(iconPath));

    expect(layers.map(({ width, height }) => [width, height])).toEqual(
      [16, 24, 32, 48, 64, 128, 256].map((size) => [size, size]),
    );
    for (const { pixels } of layers) {
      const colors = new Set<string>();
      for (let offset = 0; offset < pixels.length; offset += 4) {
        colors.add(`${pixels[offset + 2]},${pixels[offset + 1]},${pixels[offset]},${pixels[offset + 3]}`);
      }
      expect(colors.has("32,40,42,255")).toBe(true);
      expect(colors.has("0,143,131,255")).toBe(true);
      expect(colors.has("255,255,255,255")).toBe(true);
    }
  });

  it("exposes make at both workspace levels and rejects Forge publish", () => {
    expect(packageJson.scripts.make).toBe("node scripts/run-forge.mjs make");
    expect(rootPackageJson.scripts.make).toBe("npm run make --workspace @innorder/desktop");

    const source = readFileSync(path.join(desktopRoot, "scripts", "run-forge.mjs"), "utf8");
    expect(source).toContain('operation !== "make"');
    expect(source).toContain('platform: "win32", arch: "x64"');
    expect(source).not.toMatch(/api\.publish|operation\s*===?\s*["']publish["']/);
  });

  it("disables production source maps", () => {
    expect(mainViteConfig.build?.sourcemap).toBe(false);
    expect(preloadViteConfig.build?.sourcemap).toBe(false);
    expect(rendererViteConfig.build?.sourcemap).toBe(false);
  });

  it("preflights only the current branded packaged executable", async () => {
    const helperPath = path.join(desktopRoot, "smoke", "packaged-app.ts");
    expect(existsSync(helperPath)).toBe(true);
    if (!existsSync(helperPath)) return;

    const root = await mkdtemp(path.join(tmpdir(), "innorder-packaged-app-"));
    try {
      const currentExecutable = path.join(root, "out", "Innorder OCC-win32-x64", "InnorderOCC.exe");
      const staleExecutable = path.join(root, "out", "@innorder-desktop-win32-x64", "@innorder-desktop.exe");
      await mkdir(path.dirname(currentExecutable), { recursive: true });
      await mkdir(path.dirname(staleExecutable), { recursive: true });
      await writeFile(path.join(root, "package.json"), JSON.stringify({ productName: "Innorder OCC" }));
      await writeFile(currentExecutable, "current");
      await writeFile(staleExecutable, "stale");

      const { preflightPackagedExecutable } = await import(pathToFileURL(helperPath).href);
      expect(await preflightPackagedExecutable(root)).toBe(currentExecutable);

      for (const spec of ["packaged.spec.ts", "accessibility.spec.ts"]) {
        const source = readFileSync(path.join(desktopRoot, "smoke", spec), "utf8");
        expect(source).toContain("preflightPackagedExecutable");
        expect(source).not.toContain("@innorder-desktop-win32-x64");
        expect(source).not.toContain("@innorder-desktop.exe");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects missing branded output even when the obsolete executable exists", async () => {
    const helperPath = path.join(desktopRoot, "smoke", "packaged-app.ts");
    expect(existsSync(helperPath)).toBe(true);
    if (!existsSync(helperPath)) return;

    const root = await mkdtemp(path.join(tmpdir(), "innorder-missing-package-"));
    try {
      const staleExecutable = path.join(root, "out", "@innorder-desktop-win32-x64", "@innorder-desktop.exe");
      await mkdir(path.dirname(staleExecutable), { recursive: true });
      await writeFile(path.join(root, "package.json"), JSON.stringify({ productName: "Innorder OCC" }));
      await writeFile(staleExecutable, "stale");

      const { preflightPackagedExecutable } = await import(pathToFileURL(helperPath).href);
      await expect(preflightPackagedExecutable(root)).rejects.toThrow(/InnorderOCC\.exe.*does not exist/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects packaged output when package product identity differs", async () => {
    const helperPath = path.join(desktopRoot, "smoke", "packaged-app.ts");
    expect(existsSync(helperPath)).toBe(true);
    if (!existsSync(helperPath)) return;

    const root = await mkdtemp(path.join(tmpdir(), "innorder-package-identity-"));
    try {
      const executable = path.join(root, "out", "Innorder OCC-win32-x64", "InnorderOCC.exe");
      await mkdir(path.dirname(executable), { recursive: true });
      await writeFile(path.join(root, "package.json"), JSON.stringify({ productName: "Wrong Product" }));
      await writeFile(executable, "current");

      const { preflightPackagedExecutable } = await import(pathToFileURL(helperPath).href);
      await expect(preflightPackagedExecutable(root)).rejects.toThrow(/expected Innorder OCC/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes only the product-owned obsolete package directory", async () => {
    const helperPath = path.join(desktopRoot, "scripts", "package-output.mts");
    expect(existsSync(helperPath)).toBe(true);
    if (!existsSync(helperPath)) return;

    const root = await mkdtemp(path.join(tmpdir(), "innorder-package-output-"));
    try {
      const staleFile = path.join(root, "out", "@innorder-desktop-win32-x64", "@innorder-desktop.exe");
      const currentFile = path.join(root, "out", "Innorder OCC-win32-x64", "InnorderOCC.exe");
      const unrelatedFile = path.join(root, "out", "user-notes", "keep.txt");
      for (const file of [staleFile, currentFile, unrelatedFile]) {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, file);
      }

      const { removeObsoletePackageOutput } = await import(pathToFileURL(helperPath).href);
      await removeObsoletePackageOutput(root);

      await expect(access(staleFile)).rejects.toThrow();
      await expect(access(currentFile)).resolves.toBeUndefined();
      await expect(access(unrelatedFile)).resolves.toBeUndefined();
      const runner = readFileSync(path.join(desktopRoot, "scripts", "run-forge.mjs"), "utf8");
      expect(runner).toContain("removeObsoletePackageOutput");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("permits packaged smoke inspection only for a matching token in generated output", async () => {
    const helperPath = path.join(desktopRoot, "src", "packaged-smoke-inspector.ts");
    expect(existsSync(helperPath)).toBe(true);
    if (!existsSync(helperPath)) return;

    const { enablePackagedSmokeInspector } = await import(pathToFileURL(helperPath).href);
    const token = "a".repeat(64);
    const generatedExecutable = path.join(
      repositoryRoot,
      "apps",
      "desktop",
      "out",
      "Innorder OCC-win32-x64",
      "InnorderOCC.exe",
    );
    const installedExecutable = path.join("C:\\Program Files", "Innorder OCC", "InnorderOCC.exe");
    const openInspector = vi.fn();

    expect(enablePackagedSmokeInspector({
      execPath: installedExecutable,
      argv: [`--occ-packaged-smoke-token=${token}`],
      environmentToken: token,
      openInspector,
    })).toBe(false);
    expect(enablePackagedSmokeInspector({
      execPath: generatedExecutable,
      argv: ["--occ-packaged-smoke-token=wrong"],
      environmentToken: token,
      openInspector,
    })).toBe(false);
    expect(openInspector).not.toHaveBeenCalled();

    expect(enablePackagedSmokeInspector({
      execPath: generatedExecutable,
      argv: [`--occ-packaged-smoke-token=${token}`],
      environmentToken: token,
      openInspector,
    })).toBe(true);
    expect(openInspector).toHaveBeenCalledWith(0, "127.0.0.1", false);
  });
});
