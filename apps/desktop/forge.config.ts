import path from "node:path";

import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

const iconPath = path.join("assets", "occ.ico");
const description = "Innorder OCC 运营控制中心 / Operations Control Center";

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: "Innorder OCC",
    executableName: "InnorderOCC",
    icon: iconPath,
    appBundleId: "com.innorder.occ",
    appCopyright: "Copyright (c) 2026 Innorder",
    appVersion: "0.1.0",
    buildVersion: "0.1.0",
    win32metadata: {
      CompanyName: "Innorder",
      FileDescription: description,
      InternalName: "InnorderOCC",
      OriginalFilename: "InnorderOCC.exe",
      ProductName: "Innorder OCC",
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: "com.innorder.occ",
      authors: "Innorder",
      owners: "Innorder",
      title: "Innorder OCC",
      description,
      version: "0.1.0",
      copyright: "Copyright (c) 2026 Innorder",
      exe: "InnorderOCC.exe",
      setupExe: "InnorderOCC-0.1.0-x64-unsigned-dev-Setup.exe",
      setupIcon: path.resolve(__dirname, iconPath),
      nuspecTemplate: path.resolve(__dirname, "assets", "squirrel.nuspectemplate"),
      noMsi: true,
      usePackageJson: false,
    }, ["win32"]),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "src/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
