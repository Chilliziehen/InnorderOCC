import path from "node:path";

import { _electron as electron, expect, test, type Page } from "playwright/test";

const executablePath = path.resolve(
  "out/@innorder-desktop-win32-x64/@innorder-desktop.exe",
);

const mutedTextSelectors = [
  ".section-kicker",
  ".entry-form label",
];

interface Rgb {
  red: number;
  green: number;
  blue: number;
}

function parseRgb(value: string): Rgb {
  const channels = value.match(/[\d.]+/g)?.map(Number);
  if (!channels || channels.length < 3) {
    throw new Error(`Unsupported color: ${value}`);
  }
  return { red: channels[0]!, green: channels[1]!, blue: channels[2]! };
}

function luminance({ red, green, blue }: Rgb): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(luminance(parseRgb(foreground)), luminance(parseRgb(background)));
  const darker = Math.min(luminance(parseRgb(foreground)), luminance(parseRgb(background)));
  return (lighter + 0.05) / (darker + 0.05);
}

test("packaged OCC desktop enforces runtime and visual baselines", async () => {
  const runtimeErrors: string[] = [];
  const monitoredPages = new WeakSet<Page>();
  const monitor = (page: Page) => {
    if (monitoredPages.has(page)) return;
    monitoredPages.add(page);
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type())) {
        runtimeErrors.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
  };

  const application = await electron.launch({ executablePath });
  application.on("window", monitor);
  application.windows().forEach(monitor);

  try {
    const packagedElectronVersion = await application.evaluate(() => process.versions.electron);
    expect(packagedElectronVersion).toBe("43.2.0");

    const page = await application.firstWindow();
    monitor(page);

    const documentResponse = await page.reload({ waitUntil: "domcontentloaded" });
    if (!documentResponse) {
      throw new Error("Packaged reload did not expose its main document response");
    }
    await expect(page.getByRole("heading", { name: "连接服务器" })).toBeVisible();
    await expect(page.locator("form")).toBeVisible();
    expect((await page.locator("body").innerText()).trim().length).toBeGreaterThan(50);

    const responseCsp = (await documentResponse.allHeaders())[
      "content-security-policy"
    ];
    expect(responseCsp).toContain("default-src 'self'");
    expect(responseCsp).toContain("script-src 'self'");
    expect(responseCsp).toContain("object-src 'none'");
    expect(responseCsp).toContain("base-uri 'none'");
    expect(responseCsp).toContain("frame-ancestors 'none'");
    expect(responseCsp).not.toContain("unsafe-eval");

    const rendererBoundary = await page.evaluate(() => ({
      requireType: typeof (globalThis as { require?: unknown }).require,
      processType: typeof (globalThis as { process?: unknown }).process,
      occKeys: Object.keys((globalThis as unknown as { occ: object }).occ),
    }));
    expect(rendererBoundary).toEqual({
      requireType: "undefined",
      processType: "undefined",
      occKeys: ["profiles", "session", "runtime", "workspaces", "commands", "uploads", "notifications"],
    });

    const metaCsp = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute("content");
    expect(metaCsp).not.toContain("frame-ancestors");
    expect(metaCsp).not.toContain("report-uri");
    expect(metaCsp).not.toContain("sandbox");

    const initialWindowCount = application.windows().length;
    const popupWasCreated = await page.evaluate(() =>
      Boolean(window.open("https://example.com/", "_blank")),
    );
    await page.waitForTimeout(200);
    expect(popupWasCreated).toBe(false);
    expect(application.windows()).toHaveLength(initialWindowCount);

    const rendererUrl = page.url();
    await page.evaluate(() => {
      window.location.href = "https://example.com/";
    });
    await page.waitForTimeout(200);
    expect(page.url()).toBe(rendererUrl);

    const viewportMeasurements = [];
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setMinimumSize(480, 500);
    });
    for (const [width, height] of [
      [600, 700],
      [768, 700],
      [1280, 800],
    ] as const) {
      await application.evaluate(({ BrowserWindow }, size) => {
        BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
      }, { width, height });
      await page.waitForTimeout(100);
      const measurement = await page.evaluate(() => ({
        innerWidth: window.innerWidth,
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
      }));
      viewportMeasurements.push({ requestedWidth: width, ...measurement });
      expect(measurement.innerWidth).toBeGreaterThanOrEqual(width);
      expect(measurement.innerWidth).toBeLessThanOrEqual(width + 1);
      expect(measurement.scrollWidth).toBeLessThanOrEqual(measurement.clientWidth);
      expect(measurement.bodyScrollWidth).toBeLessThanOrEqual(measurement.clientWidth);
    }

    const textStyles = await page.evaluate((selectors) =>
      selectors.map((selector) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) throw new Error(`Missing contrast target: ${selector}`);
        const style = getComputedStyle(element);
        let parent: HTMLElement | null = element;
        let backgroundColor = "rgb(255, 255, 255)";
        while (parent) {
          const candidate = getComputedStyle(parent).backgroundColor;
          if (!candidate.endsWith(", 0)")) {
            backgroundColor = candidate;
            break;
          }
          parent = parent.parentElement;
        }
        return {
          selector,
          color: style.color,
          backgroundColor,
          fontSize: Number.parseFloat(style.fontSize),
        };
      }), mutedTextSelectors);

    const contrastMeasurements = textStyles.map((style) => ({
      ...style,
      contrast: contrastRatio(style.color, style.backgroundColor),
    }));
    for (const style of contrastMeasurements) {
      expect(style.fontSize, style.selector).toBeGreaterThanOrEqual(12);
      expect(
        style.contrast,
        `${style.selector}: ${style.color} on ${style.backgroundColor}`,
      ).toBeGreaterThanOrEqual(4.5);
    }

    console.log("viewport-measurements", JSON.stringify(viewportMeasurements));
    console.log("contrast-measurements", JSON.stringify(contrastMeasurements));
    console.log("response-csp", responseCsp);
    expect(runtimeErrors).toEqual([]);
  } finally {
    await application.close();
  }
});
