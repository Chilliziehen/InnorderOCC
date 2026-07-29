import path from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, session } from "electron";

import {
  applyWindowSecurity,
  createWindowOptions,
  registerProductionCsp,
} from "./electron-security";
import { registerSystemStatusIpc } from "./system-status-ipc";

const CORE_BASE_URL = process.env.CORE_BASE_URL ?? "http://127.0.0.1:8080";
const AI_BASE_URL = process.env.AI_BASE_URL ?? "http://127.0.0.1:3100";
const STATUS_TIMEOUT_MS = 4_000;

let removeStatusHandler: (() => void) | undefined;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow(
    createWindowOptions(path.join(__dirname, "preload.js")),
  );

  let rendererUrl: string;
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    rendererUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL;
  } else {
    rendererUrl = pathToFileURL(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    ).href;
  }

  applyWindowSecurity(window.webContents, rendererUrl);
  window.once("ready-to-show", () => window.show());

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  return window;
}

void app.whenReady().then(() => {
  if (app.isPackaged) {
    registerProductionCsp(session.defaultSession.webRequest);
  }

  removeStatusHandler = registerSystemStatusIpc({
    coreBaseUrl: CORE_BASE_URL,
    aiBaseUrl: AI_BASE_URL,
    timeoutMs: STATUS_TIMEOUT_MS,
  });
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  removeStatusHandler?.();
  removeStatusHandler = undefined;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
