import AxeBuilder from "@axe-core/playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, test, type Page } from "playwright/test";

const executablePath = path.resolve("out/@innorder-desktop-win32-x64/@innorder-desktop.exe");

async function emulateForcedColors(page: Page): Promise<"playwright" | "cdp"> {
  try {
    await page.emulateMedia({ forcedColors: "active" });
    if (await page.evaluate(() => matchMedia("(forced-colors: active)").matches)) return "playwright";
  } catch {
    // Electron versions can lag Playwright's media emulation surface.
  }
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setEmulatedMedia", {
    features: [{ name: "forced-colors", value: "active" }],
  });
  return "cdp";
}

test("packaged bootstrap passes accessibility and reflow checks", async () => {
  const userData = await mkdtemp(path.join(tmpdir(), "innorder-a11y-"));
  const application = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`],
  });

  try {
    const page = await application.firstWindow();
    await expect(page.getByRole("heading", { name: "连接服务器" })).toBeVisible();

    const axeResult = await new AxeBuilder({ page }).setLegacyMode().analyze();
    expect(axeResult.violations).toEqual([]);

    await page.locator("body").click({ position: { x: 2, y: 2 } });
    await page.keyboard.press("Tab");
    const focusStyle = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active) return null;
      const style = getComputedStyle(active);
      return {
        tagName: active.tagName,
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
        devicePixelRatio: window.devicePixelRatio,
      };
    });
    expect(focusStyle?.tagName).toBe("INPUT");
    expect(focusStyle?.outlineStyle).not.toBe("none");
    expect((focusStyle?.outlineWidth ?? 0) * (focusStyle?.devicePixelRatio ?? 0)).toBeGreaterThanOrEqual(2);

    await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.setContentSize(1280, 720);
      window?.webContents.setZoomFactor(2);
    });
    await page.waitForTimeout(150);
    const reflow = await page.evaluate(() => {
      const controls = Array.from(document.querySelectorAll<HTMLElement>("input, select, button"))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { name: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        });
      const overlaps: string[] = [];
      for (let left = 0; left < controls.length; left += 1) {
        for (let right = left + 1; right < controls.length; right += 1) {
          const a = controls[left]!;
          const b = controls[right]!;
          if (Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)) {
            overlaps.push(`${a.name} / ${b.name}`);
          }
        }
      }
      return {
        innerWidth: window.innerWidth,
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        overlaps,
      };
    });
    expect(reflow.innerWidth).toBeGreaterThanOrEqual(639);
    expect(reflow.innerWidth).toBeLessThanOrEqual(641);
    expect(reflow.scrollWidth).toBeLessThanOrEqual(reflow.clientWidth);
    expect(reflow.bodyScrollWidth).toBeLessThanOrEqual(reflow.clientWidth);
    expect(reflow.overlaps).toEqual([]);

    await page.emulateMedia({ reducedMotion: "reduce" });
    const reducedMotion = await page.evaluate(() => {
      const style = getComputedStyle(document.querySelector("button")!);
      return {
        matches: matchMedia("(prefers-reduced-motion: reduce)").matches,
        animationDuration: Number.parseFloat(style.animationDuration),
        transitionDuration: Number.parseFloat(style.transitionDuration),
      };
    });
    expect(reducedMotion.matches).toBe(true);
    expect(reducedMotion.animationDuration).toBeLessThanOrEqual(0.01);
    expect(reducedMotion.transitionDuration).toBeLessThanOrEqual(0.01);

    const forcedColorsMethod = await emulateForcedColors(page);
    const forcedColors = await page.evaluate(() => {
      const style = getComputedStyle(document.querySelector("input")!);
      return {
        matches: matchMedia("(forced-colors: active)").matches,
        borderStyle: style.borderStyle,
        borderWidth: Number.parseFloat(style.borderWidth),
        devicePixelRatio: window.devicePixelRatio,
      };
    });
    expect(forcedColors.matches, forcedColorsMethod).toBe(true);
    expect(forcedColors.borderStyle).not.toBe("none");
    expect(forcedColors.borderWidth * forcedColors.devicePixelRatio).toBeGreaterThanOrEqual(1);
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});
