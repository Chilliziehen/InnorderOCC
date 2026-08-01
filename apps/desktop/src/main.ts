import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, safeStorage, session } from "electron";

import { createCoreClient } from "./core-client";
import {
  createAtomicJsonPersistence,
  createDesktopApi,
  createSafeStorageVault,
  registerDesktopIpc,
} from "./desktop-ipc";
import {
  applyWindowSecurity,
  createWindowOptions,
  isDevelopmentHttpEnabled,
  registerPermissionDenial,
  registerProductionCsp,
  registerSingleInstanceLifecycle,
} from "./electron-security";
import { createProfileStore } from "./profile-store";
import { createSessionManager } from "./session-manager";
import { fetchSystemStatuses } from "./system-status-ipc";

const CORE_BASE_URL = process.env.CORE_BASE_URL ?? "http://127.0.0.1:8080";
const AI_BASE_URL = process.env.AI_BASE_URL ?? "http://127.0.0.1:3100";
const STATUS_TIMEOUT_MS = 4_000;

let mainWindow: BrowserWindow | undefined;
let disposeDesktopIpc: (() => void) | undefined;
let disposeSession: (() => void) | undefined;

function rendererDocumentUrl(): string {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) return MAIN_WINDOW_VITE_DEV_SERVER_URL;
  return pathToFileURL(
    path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
  ).href;
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow(
    createWindowOptions(path.join(__dirname, "preload.js")),
  );

  const rendererUrl = rendererDocumentUrl();

  applyWindowSecurity(window.webContents, rendererUrl);
  window.once("ready-to-show", () => window.show());

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
  window.once("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });

  return window;
}

const ownsInstance = registerSingleInstanceLifecycle(app, () => mainWindow);

if (ownsInstance) void app.whenReady().then(async () => {
  if (app.isPackaged) {
    registerProductionCsp(session.defaultSession.webRequest);
  }
  registerPermissionDenial(session.defaultSession);

  const userData = app.getPath("userData");
  const profilePersistence = createAtomicJsonPersistence(
    path.join(userData, "profiles.json"),
    fs,
  );
  const credentialPersistence = createAtomicJsonPersistence(
    path.join(userData, "credentials.json"),
    fs,
  );
  const profiles = await createProfileStore({
    ...profilePersistence,
    packaged: app.isPackaged,
    allowDevelopmentHttp: isDevelopmentHttpEnabled(
      app.isPackaged,
      process.env.OCC_ALLOW_DEVELOPMENT_HTTP,
    ),
  });
  let accessToken: string | null = null;
  const selectedProfile = () => {
    const selected = profiles.selected();
    if (!selected) throw new Error("No server profile selected");
    return selected;
  };
  const core = createCoreClient({
    fetch,
    getOrigin: () => selectedProfile().origin,
    getAccessToken: () => accessToken,
    timeoutMs: STATUS_TIMEOUT_MS,
  });
  const sessionManager = createSessionManager({
    core,
    vault: createSafeStorageVault(safeStorage, credentialPersistence),
    getProfileId: () => selectedProfile().id,
    setAccessToken: (value) => void (accessToken = value),
  });
  disposeSession = () => sessionManager.dispose();
  const api = createDesktopApi({
    profiles,
    session: sessionManager,
    statuses: () => fetchSystemStatuses({
      coreBaseUrl: profiles.selected()?.origin ?? CORE_BASE_URL,
      aiBaseUrl: AI_BASE_URL,
      timeoutMs: STATUS_TIMEOUT_MS,
    }),
    clearProfile: async () => undefined,
  });

  disposeDesktopIpc = registerDesktopIpc(rendererDocumentUrl(), api);
  mainWindow = createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on("before-quit", () => {
  disposeDesktopIpc?.();
  disposeDesktopIpc = undefined;
  disposeSession?.();
  disposeSession = undefined;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
