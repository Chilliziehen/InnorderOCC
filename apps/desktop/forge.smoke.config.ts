import path from "node:path";

import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: "Innorder OCC Smoke",
    executableName: "InnorderOCCSmoke",
    icon: path.join("assets", "occ.ico"),
    appBundleId: "com.innorder.occ.smoke",
    appVersion: "0.1.0",
    buildVersion: "0.1.0",
    win32metadata: {
      CompanyName: "Innorder",
      FileDescription: "Innorder OCC isolated smoke artifact",
      InternalName: "InnorderOCCSmoke",
      OriginalFilename: "InnorderOCCSmoke.exe",
      ProductName: "Innorder OCC Smoke",
    },
  },
  rebuildConfig: {},
  makers: [],
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/main.ts", config: "vite.smoke.config.ts", target: "main" },
        { entry: "src/preload.ts", config: "vite.preload.config.ts", target: "preload" },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: true,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
