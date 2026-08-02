import AxeBuilder from "@axe-core/playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, test, type ElectronApplication, type Page } from "playwright/test";

import { WORKSPACE_MANIFEST } from "../src/renderer/workspace-manifest";
import { packagedSmokeLaunchOptions, preflightPackagedExecutable } from "./packaged-app";

const fixtureChannels = {
  profilesList: "profiles:list",
  profilesCurrent: "profiles:current",
  profilesRemove: "profiles:remove",
  sessionRestore: "session:restore",
  runtimeStatuses: "system-statuses:get",
  workspaceQuery: "workspaces:query",
} as const;
const authenticatedRoutes = WORKSPACE_MANIFEST.map(({ path: routePath, label, title }) => ({ path: routePath, label, title }));
const fixtureCapabilities = Array.from(new Set(WORKSPACE_MANIFEST.flatMap((workspace) => [
  ...(workspace.accessCapability ? [workspace.accessCapability] : []),
  workspace.query.capability,
  ...workspace.commands.map(({ capability }) => capability),
])));
const layoutCases = [
  { name: "wide", width: 1440, height: 900, zoom: 1 },
  { name: "medium", width: 1024, height: 768, zoom: 1 },
  { name: "compact", width: 600, height: 800, zoom: 1 },
  { name: "zoomed", width: 1280, height: 720, zoom: 2 },
] as const;
const denseRoutes = [
  { path: "/overview", label: "总览", title: "运行总览" },
  { path: "/resources", label: "资源", title: "资源" },
  { path: "/administration", label: "管理", title: "管理" },
] as const;

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

async function installAuthenticatedSettingsFixture(application: ElectronApplication): Promise<void> {
  await application.evaluate(({ ipcMain }, fixture) => {
    const handlers: Array<[string, () => unknown]> = [
      [fixture.channels.profilesList, () => [fixture.profile]],
      [fixture.channels.profilesCurrent, () => fixture.profile],
      [fixture.channels.profilesRemove, () => undefined],
      [fixture.channels.sessionRestore, () => fixture.session],
      [fixture.channels.runtimeStatuses, () => fixture.statuses],
    ];
    for (const [channel, handler] of handlers) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    }
    ipcMain.removeHandler(fixture.channels.workspaceQuery);
    ipcMain.handle(fixture.channels.workspaceQuery, (_event, request: { workspace?: string }) => {
      const results = fixture.results as Record<string, unknown>;
      return results[request.workspace ?? ""] ?? fixture.unavailable;
    });
  }, {
    channels: fixtureChannels,
    profile: {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Smoke Pilot",
      origin: "https://smoke.example.test",
      environment: "pilot",
    },
    session: {
      state: "authenticated",
      user: {
        id: "00000000-0000-4000-8000-000000000002",
        username: "smoke-operator",
        displayName: "冒烟操作员",
        status: "ACTIVE",
        capabilities: fixtureCapabilities,
      },
      expiresAt: "2099-08-01T13:00:00.000Z",
    },
    statuses: [{
      service: "occ-core",
      version: "1.0.0",
      state: "READY",
      checkedAt: "2026-08-01T12:00:00.000Z",
      components: [],
    }, {
      service: "event-delivery",
      version: "2.4.1",
      state: "DEGRADED",
      checkedAt: "2026-08-01T12:01:00.000Z",
      components: [],
    }],
    results: {
      overview: {
        state: "ready",
        items: [
          { item: "待处理的高优先级装配异常", type: "attention", status: "open", dueAt: "2026-08-02T10:00:00.000Z" },
          { item: "生产批次审核时限", type: "deadline", status: "due-soon", dueAt: "2026-08-02T11:00:00.000Z" },
          { item: "关键资源容量不足", type: "risk", status: "high" },
          { item: "试点订单履行流程", type: "process", status: "RUNNING" },
        ],
        count: 4,
        fetchedAt: "2026-08-01T12:00:00.000Z",
      },
      resources: {
        state: "ready",
        items: [{
          id: "resource-smoke-1",
          name: "装配线 A 超长资源名称",
          type: "line",
          state: "available",
          capacity: 12,
          availableCapacity: 7,
          reservations: [{ id: "reservation-1", start: "2026-08-02T08:00:00.000Z", end: "2026-08-02T10:00:00.000Z", capacity: 3, state: "active" }],
          conflicts: [{ kind: "capacity", start: "2026-08-02T09:00:00.000Z", end: "2026-08-02T09:30:00.000Z", capacity: 2 }],
        }],
        count: 1,
        fetchedAt: "2026-08-01T12:00:00.000Z",
      },
      administration: {
        state: "ready",
        items: [{ subject: "值班管理员超长显示名称", type: "person", status: "active", updatedAt: "2026-08-01T12:00:00.000Z" }],
        count: 1,
        fetchedAt: "2026-08-01T12:00:00.000Z",
      },
    },
    unavailable: {
      state: "unavailable",
      reason: "UNAVAILABLE_CONTRACT",
      resourceGroups: ["/smoke"],
      message: "Smoke workspace unavailable",
    },
  });
}

async function setPackagedViewport(application: ElectronApplication, width: number, height: number, zoom: number): Promise<void> {
  await application.evaluate(({ BrowserWindow }, layout) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.webContents.setZoomFactor(layout.zoom);
    window?.setContentSize(layout.width, layout.height);
  }, { width, height, zoom });
}

async function measureLayout(page: Page) {
  return page.evaluate(() => {
    type Box = { name: string; element: Element; left: number; right: number; top: number; bottom: number };
    const viewport = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    const clippedBox = (element: Element, name: string): Box | undefined => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return undefined;
      const left = Math.max(rect.left, viewport.left);
      const right = Math.min(rect.right, viewport.right);
      const top = Math.max(rect.top, viewport.top);
      const bottom = Math.min(rect.bottom, viewport.bottom);
      return right - left > 1 && bottom - top > 1 ? { name, element, left, right, top, bottom } : undefined;
    };
    const nameOf = (element: Element) => element.getAttribute("aria-label")
      ?? element.getAttribute("data-label")
      ?? element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80)
      ?? element.tagName;
    const controls = Array.from(new Set(document.querySelectorAll<Element>("a, button, input, select, textarea, [role=tab]")))
      .flatMap((element) => {
        const box = clippedBox(element, nameOf(element));
        return box ? [box] : [];
      });
    const textBoxes: Box[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const text = node.data.trim().replace(/\s+/g, " ");
      const parent = node.parentElement;
      if (!text || !parent || parent.closest(".sr-only, [aria-hidden=true], .ant-tooltip")) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        const clipped = {
          left: Math.max(rect.left, viewport.left), right: Math.min(rect.right, viewport.right),
          top: Math.max(rect.top, viewport.top), bottom: Math.min(rect.bottom, viewport.bottom),
        };
        if (clipped.right - clipped.left > 1 && clipped.bottom - clipped.top > 1) {
          textBoxes.push({ name: text.slice(0, 80), element: parent, ...clipped });
        }
      }
    }
    const intersects = (a: Box, b: Box) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
      && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
    const overlaps: string[] = [];
    for (let left = 0; left < controls.length; left += 1) {
      for (let right = left + 1; right < controls.length; right += 1) {
        const a = controls[left]!;
        const b = controls[right]!;
        if (!a.element.contains(b.element) && !b.element.contains(a.element) && intersects(a, b)) {
          overlaps.push(`control: ${a.name} / ${b.name}`);
        }
      }
      const control = controls[left]!;
      for (const text of textBoxes) {
        if (control.element.contains(text.element) || text.element.closest("a, button") === control.element) continue;
        if (intersects(control, text)) overlaps.push(`control/text: ${control.name} / ${text.name}`);
      }
    }
    const visibleDataLabels = Array.from(document.querySelectorAll<HTMLElement>("[data-label]"))
      .filter((element) => {
        const pseudo = getComputedStyle(element, "::before");
        return pseudo.display !== "none" && pseudo.visibility !== "hidden" && pseudo.content !== "none" && pseudo.content !== '""';
      })
      .map((element) => element.dataset.label ?? "");
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      overlaps: Array.from(new Set(overlaps)),
      visibleDataLabels,
      navNames: Array.from(document.querySelectorAll<HTMLAnchorElement>("nav[aria-label='主导航'] a")).map((link) => link.getAttribute("aria-label")),
    };
  });
}

async function measureFullLayout(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewportHeight: window.innerHeight,
    documentHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
  }));
  const lastPosition = Math.max(0, dimensions.documentHeight - dimensions.viewportHeight);
  const increment = Math.max(1, Math.floor(dimensions.viewportHeight * 0.8));
  const positions = new Set<number>([0, lastPosition]);
  for (let position = increment; position < lastPosition; position += increment) positions.add(position);

  let combined: Awaited<ReturnType<typeof measureLayout>> | undefined;
  for (const position of positions) {
    await page.evaluate((top) => window.scrollTo(0, top), position);
    await page.waitForTimeout(10);
    const current = await measureLayout(page);
    combined = combined ? {
      ...current,
      overlaps: Array.from(new Set([...combined.overlaps, ...current.overlaps])),
      visibleDataLabels: Array.from(new Set([...combined.visibleDataLabels, ...current.visibleDataLabels])),
    } : current;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  return combined!;
}

test("packaged bootstrap passes accessibility and reflow checks", async () => {
  const executablePath = await preflightPackagedExecutable();
  const userData = await mkdtemp(path.join(tmpdir(), "innorder-a11y-"));
  const application = await electron.launch(packagedSmokeLaunchOptions(
    executablePath,
    [`--user-data-dir=${userData}`],
  ));

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

test("packaged settings restores modal trigger focus after shell isolation clears", async () => {
  const executablePath = await preflightPackagedExecutable();
  const userData = await mkdtemp(path.join(tmpdir(), "innorder-modal-"));
  const application = await electron.launch(packagedSmokeLaunchOptions(
    executablePath,
    [`--user-data-dir=${userData}`],
  ));

  try {
    const page = await application.firstWindow();
    await installAuthenticatedSettingsFixture(application);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "运行总览" })).toBeVisible();
    await page.getByRole("link", { name: "设置" }).click();
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();

    const shell = page.locator(".app-shell");
    const trigger = page.getByRole("button", { name: "移除 Smoke Pilot" });
    await trigger.click();
    await expect(page.getByRole("dialog", { name: "确认移除配置" })).toBeVisible();
    await expect(shell).toHaveAttribute("inert", "");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(shell).not.toHaveAttribute("inert", "");
    await expect(trigger).toBeFocused();

    await trigger.click();
    await expect(shell).toHaveAttribute("inert", "");
    await page.getByRole("button", { name: "取消" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(shell).not.toHaveAttribute("inert", "");
    await expect(trigger).toBeFocused();
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test("packaged authenticated shell navigates every route", async () => {
  const executablePath = await preflightPackagedExecutable();
  const userData = await mkdtemp(path.join(tmpdir(), "innorder-routes-"));
  const application = await electron.launch(packagedSmokeLaunchOptions(
    executablePath,
    [`--user-data-dir=${userData}`],
  ));

  try {
    const page = await application.firstWindow();
    await installAuthenticatedSettingsFixture(application);
    await page.reload({ waitUntil: "domcontentloaded" });
    const navigation = page.getByRole("navigation", { name: "主导航" });
    await expect(navigation.getByRole("link")).toHaveCount(authenticatedRoutes.length);

    for (const route of authenticatedRoutes) {
      await navigation.getByRole("link", { name: route.label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`#${route.path.replace("-", "\\-")}$`));
      await expect(page.getByRole("heading", { name: route.title, exact: true }).first(), route.path).toBeVisible();
    }
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test("packaged authenticated layout matrix has no overflow or visible overlap", async () => {
  const executablePath = await preflightPackagedExecutable();
  const userData = await mkdtemp(path.join(tmpdir(), "innorder-layout-"));
  const application = await electron.launch(packagedSmokeLaunchOptions(
    executablePath,
    [`--user-data-dir=${userData}`],
  ));

  try {
    const page = await application.firstWindow();
    await installAuthenticatedSettingsFixture(application);
    await page.reload({ waitUntil: "domcontentloaded" });
    const routeLabels = authenticatedRoutes.map(({ label }) => label);

    for (const viewport of layoutCases) {
      await setPackagedViewport(application, viewport.width, viewport.height, viewport.zoom);
      await page.waitForTimeout(150);
      for (const route of denseRoutes) {
        const navigation = page.getByRole("navigation", { name: "主导航" });
        const routeLink = navigation.getByRole("link", { name: route.label, exact: true });
        await routeLink.evaluate((link) => (link as HTMLAnchorElement).click());
        await expect(page.getByRole("heading", { name: route.title, exact: true }).first()).toBeVisible();
        if (route.path === "/overview") await expect(page.getByText("待处理的高优先级装配异常")).toBeVisible();
        if (route.path === "/resources") await expect(page.getByText("装配线 A 超长资源名称")).toBeVisible();
        if (route.path === "/administration") await expect(page.getByText("值班管理员超长显示名称")).toBeVisible();

        const layout = await measureFullLayout(page);
        const context = `${route.path} ${viewport.name} ${layout.innerWidth}x${layout.innerHeight}`;
        expect(layout.scrollWidth, context).toBeLessThanOrEqual(layout.clientWidth);
        expect(layout.bodyScrollWidth, context).toBeLessThanOrEqual(layout.clientWidth);
        expect(layout.overlaps, context).toEqual([]);
        expect(layout.navNames, context).toEqual(routeLabels);

        if (layout.innerWidth <= 700) {
          if (route.path === "/overview") expect(layout.visibleDataLabels, context).toEqual(expect.arrayContaining(["服务", "状态", "版本", "环境", "新鲜度"]));
          if (route.path === "/administration") expect(layout.visibleDataLabels, context).toEqual(expect.arrayContaining(["对象", "类型", "状态", "更新时间"]));
          if (route.path === "/resources") {
            await expect(page.getByRole("region", { name: "资源库存详情" }).locator("dt"), context).toHaveText(["类型", "状态", "容量"]);
          }
          await routeLink.dispatchEvent("mouseenter");
          await routeLink.dispatchEvent("mouseover");
          await expect(page.getByRole("tooltip", { name: route.label, exact: true }), context).toBeVisible();
          await routeLink.dispatchEvent("mouseleave");
        }
      }
    }
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test("packaged pending profile removal keeps focus inside the dialog", async () => {
  const executablePath = await preflightPackagedExecutable();
  const userData = await mkdtemp(path.join(tmpdir(), "innorder-modal-pending-"));
  const application = await electron.launch(packagedSmokeLaunchOptions(
    executablePath,
    [`--user-data-dir=${userData}`],
  ));

  try {
    const page = await application.firstWindow();
    await installAuthenticatedSettingsFixture(application);
    await application.evaluate(({ ipcMain }, channel) => {
      const state = globalThis as typeof globalThis & { pendingRemoveCalls?: number };
      state.pendingRemoveCalls = 0;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => {
        state.pendingRemoveCalls = (state.pendingRemoveCalls ?? 0) + 1;
        return new Promise(() => undefined);
      });
    }, fixtureChannels.profilesRemove);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: "设置" }).click();

    const shell = page.locator(".app-shell");
    await page.getByRole("button", { name: "移除 Smoke Pilot" }).click();
    const dialog = page.getByRole("dialog", { name: "确认移除配置" });
    await page.getByRole("button", { name: "确认移除" }).click();
    const pendingConfirm = page.getByRole("button", { name: "正在移除" });
    await expect(pendingConfirm).toBeDisabled();
    await expect(page.getByRole("button", { name: "取消" })).toBeDisabled();
    await expect(dialog).toBeFocused();

    for (const key of ["Tab", "Shift+Tab", "Escape"]) {
      await page.keyboard.press(key);
      await expect(dialog, key).toBeFocused();
      await expect(dialog, key).toBeVisible();
      await expect(shell, key).toHaveAttribute("inert", "");
    }
    await pendingConfirm.evaluate((button) => (button as HTMLButtonElement).click());
    expect(await application.evaluate(() => (globalThis as typeof globalThis & { pendingRemoveCalls?: number }).pendingRemoveCalls)).toBe(1);
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});
