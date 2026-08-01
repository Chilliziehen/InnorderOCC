import type {
  BrowserWindowConstructorOptions,
  WebContents,
  WebRequest,
} from "electron";

import { isAllowedNavigation } from "./navigation-policy";

export const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function createWindowOptions(
  preloadPath: string,
): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 800,
    minWidth: 768,
    minHeight: 600,
    useContentSize: true,
    backgroundColor: "#f4f6f7",
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  };
}

export function applyWindowSecurity(
  webContents: Pick<WebContents, "setWindowOpenHandler" | "on">,
  rendererUrl: string,
): void {
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  webContents.on("will-navigate", (details) => {
    if (!isAllowedNavigation(rendererUrl, details.url)) {
      details.preventDefault();
    }
  });
}

export function registerProductionCsp(
  webRequest: Pick<WebRequest, "onHeadersReceived">,
): void {
  webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [PRODUCTION_CSP],
      },
    });
  });
}

interface PermissionSession {
  setPermissionRequestHandler(
    handler: (webContents: unknown, permission: string, callback: (allowed: boolean) => void) => void,
  ): void;
  setPermissionCheckHandler(
    handler: (webContents: unknown, permission: string) => boolean,
  ): void;
}

export function registerPermissionDenial(target: PermissionSession): void {
  target.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
}

interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: "second-instance", listener: () => void): unknown;
}

interface FocusableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
}

export function registerSingleInstanceLifecycle(
  target: SingleInstanceApp,
  getWindow: () => FocusableWindow | undefined,
): boolean {
  if (!target.requestSingleInstanceLock()) {
    target.quit();
    return false;
  }
  target.on("second-instance", () => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  return true;
}
