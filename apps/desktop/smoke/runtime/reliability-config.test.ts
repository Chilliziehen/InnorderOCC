// @vitest-environment node

import { readFileSync } from "node:fs";
import path from "node:path";

import { FuseV1Options } from "@electron/fuses";
import { describe, expect, it } from "vitest";

import productionForgeConfig from "../../forge.config";
import smokeForgeConfig from "../../forge.smoke.config";
import reliabilityPlaywrightConfig from "../../playwright.reliability.config";
import smokeViteConfig from "../../vite.smoke.config";

const desktopRoot = path.resolve(__dirname, "../..");
const repositoryRoot = path.resolve(desktopRoot, "../..");

describe("reliability smoke artifact configuration", () => {
  it("packages a distinct executable and application identity", () => {
    expect(smokeForgeConfig.packagerConfig).toMatchObject({
      asar: true,
      name: "Innorder OCC Smoke",
      executableName: "InnorderOCCSmoke",
      appBundleId: "com.innorder.occ.smoke",
      win32metadata: {
        InternalName: "InnorderOCCSmoke",
        OriginalFilename: "InnorderOCCSmoke.exe",
        ProductName: "Innorder OCC Smoke",
      },
    });
  });

  it("aliases the adapter only in the smoke main compile and never in production config", () => {
    const alias = Array.isArray(smokeViteConfig.resolve?.alias) ? smokeViteConfig.resolve.alias[0] : undefined;
    expect(String(alias && "replacement" in alias ? alias.replacement : "")).toMatch(/smoke[\\/]runtime[\\/]smoke-runtime-adapter\.ts$/);
    for (const file of ["forge.config.ts", "vite.main.config.ts", "package.json"]) {
      expect(readFileSync(path.join(desktopRoot, file), "utf8")).not.toContain("smoke-runtime-adapter");
    }
  });

  it("enables Playwright inspection only in the isolated smoke executable", () => {
    type FusePlugin = { fusesConfig?: Record<string, unknown> };
    const smokeFuses = (smokeForgeConfig.plugins as FusePlugin[]).find(({ fusesConfig }) => fusesConfig);
    const productionFuses = (productionForgeConfig.plugins as FusePlugin[]).find(({ fusesConfig }) => fusesConfig);
    expect(smokeFuses?.fusesConfig?.[FuseV1Options.EnableNodeCliInspectArguments]).toBe(true);
    expect(productionFuses?.fusesConfig?.[FuseV1Options.EnableNodeCliInspectArguments]).toBe(false);
  });

  it("exposes bounded package and reliability commands at both workspace levels", () => {
    const desktopPackage = JSON.parse(readFileSync(path.join(desktopRoot, "package.json"), "utf8"));
    const rootPackage = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    expect(desktopPackage.scripts).toMatchObject({
      "package:smoke": "node scripts/run-forge.mjs package:smoke",
      "smoke:reliability": "playwright test --config playwright.reliability.config.ts",
    });
    expect(rootPackage.scripts).toMatchObject({
      "package:smoke": "npm run package:smoke --workspace @innorder/desktop",
      "smoke:reliability": "npm run smoke:reliability --workspace @innorder/desktop",
    });
  });

  it("runs only the reliability journey with one worker and list plus JUnit output", () => {
    expect(reliabilityPlaywrightConfig.testDir).toBe("./smoke");
    expect(reliabilityPlaywrightConfig.testMatch).toBe("reliability.spec.ts");
    expect(reliabilityPlaywrightConfig.workers).toBe(1);
    expect(reliabilityPlaywrightConfig.fullyParallel).toBe(false);
    expect(reliabilityPlaywrightConfig.reporter).toEqual([
      ["list"],
      ["junit", { outputFile: "test-results/reliability-junit.xml" }],
    ]);
  });
});
