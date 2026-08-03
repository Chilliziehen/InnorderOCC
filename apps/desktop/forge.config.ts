import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";

import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

import { SQUIRREL_PACKAGE_ID, WINDOWS_EXECUTABLE_NAME } from "./src/product-identity";

const iconPath = path.join("assets", "occ.ico");
const description = "Innorder OCC 运营控制中心 / Operations Control Center";
const require = createRequire(import.meta.url);
const desktopPackage = require("./package.json") as { version: string };
const appVersion = desktopPackage.version;
const deploymentPayload = path.resolve(__dirname, "assets", "deployment-ca");

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    name: "Innorder OCC",
    executableName: WINDOWS_EXECUTABLE_NAME,
    icon: iconPath,
    appBundleId: SQUIRREL_PACKAGE_ID,
    appCopyright: "Copyright (c) 2026 Innorder",
    appVersion,
    buildVersion: appVersion,
    extraResource: [
      path.resolve(__dirname, "scripts", "enroll-deployment-ca.ps1"),
      path.resolve(__dirname, "scripts", "remove-deployment-ca.ps1"),
      ...(existsSync(deploymentPayload) ? [deploymentPayload] : []),
    ],
    win32metadata: {
      CompanyName: "Innorder",
      FileDescription: description,
      InternalName: WINDOWS_EXECUTABLE_NAME,
      OriginalFilename: `${WINDOWS_EXECUTABLE_NAME}.exe`,
      ProductName: "Innorder OCC",
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: SQUIRREL_PACKAGE_ID,
      authors: "Innorder",
      owners: "Innorder",
      title: "Innorder OCC",
      description,
      version: appVersion,
      copyright: "Copyright (c) 2026 Innorder",
      exe: `${WINDOWS_EXECUTABLE_NAME}.exe`,
      setupExe: `${WINDOWS_EXECUTABLE_NAME}-${appVersion}-x64-unsigned-dev-Setup.exe`,
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
