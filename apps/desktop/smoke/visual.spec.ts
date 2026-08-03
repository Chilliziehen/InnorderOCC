import { expect, test, type Page } from "playwright/test";

import { launchSmokeFixture, type SmokeRole } from "./fixtures/smoke-adapter";

const routes = [
  { name: "overview", role: "administrator", link: "总览", heading: "运行总览", data: "Pilot order exception" },
  { name: "my-work", role: "participant", link: "我的工作", heading: "我的工作", data: "Submit identity evidence" },
  { name: "intervention", role: "teacher", link: "介入中心", heading: "人工介入中心", data: "Identity evidence review" },
  { name: "resources", role: "resource-manager", link: "资源", heading: "资源", data: "Assembly line A" },
  { name: "administration", role: "administrator", link: "管理", heading: "管理", data: "Pilot Administrator" },
] as const satisfies readonly { name: string; role: SmokeRole; link: string; heading: string; data: string }[];

const layouts = [
  { name: "1440x900", width: 1440, height: 900, zoom: 1 },
  { name: "1024x768", width: 1024, height: 768, zoom: 1 },
  { name: "600x800", width: 600, height: 800, zoom: 1 },
  { name: "200-percent", width: 1024, height: 768, zoom: 2 },
] as const;

async function assertVisualIntegrity(page: Page, data: string): Promise<void> {
  await expect(page.locator("body")).toContainText(data);
  const layout = await page.evaluate(() => {
    const controls = [...document.querySelectorAll<HTMLElement>("a, button, input, select, textarea")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 1 && rect.height > 1 && style.visibility !== "hidden" && style.display !== "none";
      })
      .map((element) => ({ element, rect: element.getBoundingClientRect(), name: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName }));
    const overlaps: string[] = [];
    for (let left = 0; left < controls.length; left += 1) for (let right = left + 1; right < controls.length; right += 1) {
      const a = controls[left]!; const b = controls[right]!;
      if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
      const horizontal = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
      const vertical = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
      if (horizontal > 1 && vertical > 1) overlaps.push(`${a.name} / ${b.name}`);
    }
    return {
      bodyText: document.body.innerText.trim(),
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      clientWidth: document.documentElement.clientWidth,
      overlaps,
    };
  });
  expect(layout.bodyText.length).toBeGreaterThan(100);
  expect(layout.bodyText).toContain(data);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
  expect(layout.overlaps).toEqual([]);
}

for (const route of routes) for (const layout of layouts) {
  test(`${route.name} ${layout.name} reviewed packaged visual`, async () => {
    const fixture = await launchSmokeFixture({ role: route.role });
    try {
      await fixture.application.evaluate(({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0];
        window?.setMinimumSize(480, 500);
        window?.setContentSize(size.width - (size.zoom === 1 ? 1 : 0), size.height - (size.zoom === 1 ? 1 : 0));
        window?.webContents.setZoomFactor(size.zoom);
      }, layout);
      const { page } = fixture;
      const expectedWidth = Math.round(layout.width / layout.zoom);
      const expectedHeight = Math.round(layout.height / layout.zoom);
      await expect.poll(() => page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))).toEqual({ width: expectedWidth, height: expectedHeight });
      await page.waitForTimeout(100);
      await page.getByRole("link", { name: route.link, exact: true }).click();
      await expect(page.getByRole("heading", { name: route.heading, exact: true }).first()).toBeVisible();
      await assertVisualIntegrity(page, route.data);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.mouse.move(layout.width - 10, layout.height - 10);
      await expect(page.getByRole("tooltip")).toHaveCount(0);
      await expect(page).toHaveScreenshot(`${route.name}-${layout.name}.png`, {
        animations: "disabled",
        caret: "hide",
        scale: "css",
      });
    } finally {
      await fixture.close();
    }
  });
}
