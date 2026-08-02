import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { open as openInspector } from "node:inspector";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, safeStorage, session } from "electron";

import { createCoreClient } from "./core-client";
import { createCommandIntentRegistry } from "./command-intents";
import { synchronizeCertificateReferences } from "./certificate-manifest";
import { createConnectivityTracker } from "./connectivity";
import { handleDeploymentCaLifecycle } from "./deployment-ca-lifecycle";
import {
  createAtomicJsonPersistence,
  createAtomicTextPersistence,
  createSafeStorageVault,
  registerDesktopIpc,
  sendDesktopNotification,
  sendDesktopNotificationState,
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
import { createProfileTransport } from "./profile-transport";
import { createReadCache, READ_CACHE_MAX_BYTES } from "./read-cache";
import { createNotificationStream } from "./notification-stream";
import { enablePackagedSmokeInspector } from "./packaged-smoke-inspector";
import { SQUIRREL_APP_USER_MODEL_ID } from "./product-identity";
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

enablePackagedSmokeInspector({
  execPath: process.execPath,
  argv: process.argv,
  environmentToken: process.env.OCC_PACKAGED_SMOKE_TOKEN,
  openInspector,
});
app.setAppUserModelId(SQUIRREL_APP_USER_MODEL_ID);
const ownsInstance = registerSingleInstanceLifecycle(app, () => mainWindow);

if (ownsInstance) void app.whenReady().then(async () => {
  const lifecycle = await handleDeploymentCaLifecycle({
    argv: process.argv,
    resourcesPath: process.resourcesPath,
    userData: app.getPath("userData"),
    execPath: process.execPath,
  }, {
    exists: async (target) => fs.lstat(target).then((stat) => stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 512 * 1024, () => false),
    read: (target) => fs.readFile(target),
    invoke: ({ script, arguments: args }) => new Promise((resolve, reject) => {
      execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args], { windowsHide: true, timeout: 30_000 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    }),
  });
  if (lifecycle.handled) {
    app.quit();
    return;
  }
  if (app.isPackaged) {
    registerProductionCsp(session.defaultSession.webRequest);
  }
  registerPermissionDenial(session.defaultSession);
  const profileTransport = createProfileTransport({
    fromPartition: (name) => session.fromPartition(name) as never,
  });

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
    READ_CACHE_MAX_BYTES,
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
    synchronizeCertificateReferences: (candidateProfiles, selectedId) =>
      synchronizeCertificateReferences({
        stateDirectory: path.join(userData, "state"),
        profiles: candidateProfiles,
        selectedId,
      }),
  });
  let accessToken: string | null = null;
  let customerInstanceId: string | null = null;
  const connectivity = createConnectivityTracker();
  const selectedProfile = () => {
    const selected = profiles.selected();
    if (!selected) throw new Error("No server profile selected");
    return selected;
  };
  const core = createCoreClient({
    fetch: (input, init) => profileTransport.fetch(
      selectedProfile(),
      input instanceof URL ? input : new URL(String(input)),
      init,
    ),
    getOrigin: () => selectedProfile().origin,
    getAccessToken: () => accessToken,
    timeoutMs: STATUS_TIMEOUT_MS,
    onConnectivityChange: connectivity.recordRequestOutcome,
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
    settleCommand: (intentHandle, settlement) => commandIntents.settle(intentHandle, settlement),
    connector: () => { throw new Error("Notification contract unavailable"); },
  });
  const disposeNotificationForwarder = notificationStream.subscribe((event) => {
    if (mainWindow) sendDesktopNotification(mainWindow.webContents, event);
  });
  const disposeNotificationStateForwarder = notificationStream.subscribeState((state) => {
    if (mainWindow) sendDesktopNotificationState(mainWindow.webContents, state);
  });
  const uploads = createEvidenceUploadService({
    spoolDirectory: path.join(userData, "upload-spool"),
    getProfile: () => ({ origin: selectedProfile().origin, endpointAvailable: false }),
    getAccessToken: () => accessToken,
    isOnline: connectivity.isOnline,
    transport: async () => { throw new Error("Evidence contract unavailable"); },
    onProgress: (progress) => {
      if (mainWindow) sendDesktopUploadProgress(mainWindow.webContents, progress);
    },
  });
  void uploads.cleanupStaleSpools().catch(() => undefined);
  disposeSession = () => sessionManager.dispose();
  disposeReliability = () => {
    disposeNotificationForwarder();
    disposeNotificationStateForwarder();
    notificationStream.dispose();
    void uploads.dispose();
  };
  const api = createMainReliabilityApi({
    profiles,
    session: sessionManager,
    statuses: () => fetchSystemStatuses({
      coreBaseUrl: profiles.selected()?.origin ?? CORE_BASE_URL,
      aiBaseUrl: AI_BASE_URL,
      timeoutMs: STATUS_TIMEOUT_MS,
      coreFetch: (input, init) => profileTransport.fetch(
        selectedProfile(),
        input instanceof URL ? input : new URL(String(input)),
        init,
      ),
    }),
    clearProfile: async (profileId) => {
      await readCache.purgeProfile(profileId);
    },
    readCache,
    notificationStream,
    getCustomerInstanceId: () => customerInstanceId,
    connectivity,
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
