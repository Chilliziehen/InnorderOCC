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
