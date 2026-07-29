import { describe, expect, it, vi } from "vitest";

import {
  PRODUCTION_CSP,
  applyWindowSecurity,
  createWindowOptions,
  registerProductionCsp,
} from "../src/electron-security";

describe("Electron security configuration", () => {
  it("creates the BrowserWindow secure baseline", () => {
    const options = createWindowOptions("D:\\OCC\\preload.js");

    expect(options.minWidth).toBe(768);
    expect(options.useContentSize).toBe(true);
    expect(options.webPreferences).toMatchObject({
      preload: "D:\\OCC\\preload.js",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    });
  });

  it("denies new windows and navigation outside the renderer document", () => {
    const setWindowOpenHandler = vi.fn();
    const on = vi.fn();
    applyWindowSecurity(
      { setWindowOpenHandler, on },
      "file:///D:/OCC/index.html",
    );

    const openHandler = setWindowOpenHandler.mock.calls[0]?.[0];
    expect(openHandler?.({})).toEqual({ action: "deny" });

    const navigationHandler = on.mock.calls.find(
      ([eventName]) => eventName === "will-navigate",
    )?.[1];
    const allowedEvent = {
      preventDefault: vi.fn(),
      url: "file:///D:/OCC/index.html",
    };
    const deniedEvent = {
      preventDefault: vi.fn(),
      url: "https://example.com/",
    };
    navigationHandler?.(allowedEvent);
    navigationHandler?.(deniedEvent);
    expect(allowedEvent.preventDefault).not.toHaveBeenCalled();
    expect(deniedEvent.preventDefault).toHaveBeenCalledOnce();
  });

  it("registers a production CSP without unsafe-eval", () => {
    const onHeadersReceived = vi.fn();
    registerProductionCsp({ onHeadersReceived });

    expect(PRODUCTION_CSP).toContain("script-src 'self'");
    expect(PRODUCTION_CSP).toContain("object-src 'none'");
    expect(PRODUCTION_CSP).toContain("frame-ancestors 'none'");
    expect(PRODUCTION_CSP).not.toContain("unsafe-eval");
    expect(onHeadersReceived).toHaveBeenCalledOnce();

    const listener = onHeadersReceived.mock.calls[0]?.[0];
    const callback = vi.fn();
    listener?.({ responseHeaders: { Existing: ["value"] } }, callback);
    expect(callback).toHaveBeenCalledWith({
      responseHeaders: {
        Existing: ["value"],
        "Content-Security-Policy": [PRODUCTION_CSP],
      },
    });
  });
});
