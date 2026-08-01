import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, safeStorage, session } from "electron";

import { createCoreClient } from "./core-client";
import { createCommandIntentRegistry } from "./command-intents";
import {
  createAtomicJsonPersistence,
  createAtomicTextPersistence,
  createSafeStorageVault,
  registerDesktopIpc,
  sendDesktopNotification,
  sendDesktopUploadProgress,
} from "./desktop-ipc";
import { createEvidenceUploadService } from "./evidence-upload";
import {
  applyWindowSecurity,
  createWindowOptions,
  isDevelopmentHttpEnabled,
  registerPermissionDenial,
  registerProductionCsp,
  registerSingleInstanceLifecycle,
} from "./electron-security";
import { createProfileStore } from "./profile-store";
import { createReadCache } from "./read-cache";
import { createNotificationStream } from "./notification-stream";
import { createSessionManager, customerInstanceIdFromAccessToken } from "./session-manager";
import { createMainReliabilityApi } from "./main-reliability-composition";
import { fetchSystemStatuses } from "./system-status-ipc";

const CORE_BASE_URL = process.env.CORE_BASE_URL ?? "http://127.0.0.1:8080";
const AI_BASE_URL = process.env.AI_BASE_URL ?? "http://127.0.0.1:3100";
const STATUS_TIMEOUT_MS = 4_000;

let mainWindow: BrowserWindow | undefined;
let disposeDesktopIpc: (() => void) | undefined;
let disposeSession: (() => void) | undefined;
let disposeReliability: (() => void) | undefined;

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
  const readCachePersistence = createAtomicTextPersistence(
    path.join(userData, "workspace-read-cache.json"),
    fs,
  );
  const notificationPersistence = createAtomicJsonPersistence(
    path.join(userData, "notification-cursors.json"),
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
  let customerInstanceId: string | null = null;
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
    setAccessToken: (value) => {
      accessToken = value;
      customerInstanceId = customerInstanceIdFromAccessToken(value);
    },
  });
  const readCache = createReadCache({ persistence: readCachePersistence });
  const commandIntents = createCommandIntentRegistry();
  const notificationStream = createNotificationStream({
    persistence: notificationPersistence,
    getAccessToken: () => accessToken,
    settleCommand: (intentHandle, correlationId) => commandIntents.settle(intentHandle, correlationId),
    connector: () => { throw new Error("Notification contract unavailable"); },
  });
  const disposeNotificationForwarder = notificationStream.subscribe((event) => {
    if (mainWindow) sendDesktopNotification(mainWindow.webContents, event);
  });
  const uploads = createEvidenceUploadService({
    getProfile: () => ({ origin: selectedProfile().origin, endpointAvailable: false }),
    getAccessToken: () => accessToken,
    transport: async () => { throw new Error("Evidence contract unavailable"); },
    onProgress: (progress) => {
      if (mainWindow) sendDesktopUploadProgress(mainWindow.webContents, progress);
    },
  });
  disposeSession = () => sessionManager.dispose();
  disposeReliability = () => {
    disposeNotificationForwarder();
    notificationStream.dispose();
  };
  const api = createMainReliabilityApi({
    profiles,
    session: sessionManager,
    statuses: () => fetchSystemStatuses({
      coreBaseUrl: profiles.selected()?.origin ?? CORE_BASE_URL,
      aiBaseUrl: AI_BASE_URL,
      timeoutMs: STATUS_TIMEOUT_MS,
    }),
    clearProfile: async (profileId) => {
      await readCache.purgeProfile(profileId);
    },
    readCache,
    notificationStream,
    getCustomerInstanceId: () => customerInstanceId,
    isOnline: () => accessToken !== null,
    uploads,
  });

  disposeDesktopIpc = registerDesktopIpc(rendererDocumentUrl(), api, { commandIntents });
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
  disposeReliability?.();
  disposeReliability = undefined;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
