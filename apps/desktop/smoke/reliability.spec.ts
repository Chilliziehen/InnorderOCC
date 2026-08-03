import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, test, type ElectronApplication, type Page } from "playwright/test";

import { startReliabilityServer, type ReliabilityServer } from "./runtime/reliability-server";

const SMOKE_OUTPUT = path.join("out-smoke", "Innorder OCC Smoke-win32-x64", "InnorderOCCSmoke.exe");

async function smokeExecutable(): Promise<string> {
  const executable = path.resolve(process.cwd(), SMOKE_OUTPUT);
  if (!(await stat(executable)).isFile()) throw new Error(`Smoke executable is missing: ${executable}`);
  return executable;
}

async function launch(executablePath: string, userData: string): Promise<{ application: ElectronApplication; page: Page }> {
  const application = await electron.launch({ executablePath, args: [`--user-data-dir=${userData}`] });
  return { application, page: await application.firstWindow() };
}

async function bootstrap(page: Page, server: ReliabilityServer): Promise<void> {
  await expect(page.getByRole("heading", { name: "连接服务器" })).toBeVisible();
  await page.getByLabel("配置名称").fill("Reliability Smoke");
  await page.getByLabel("服务器源地址（精确 origin）").fill(server.origin);
  await page.getByLabel("环境").selectOption("pilot");
  await page.getByLabel("CA SHA-256 指纹（可选）").fill(server.fingerprint);
  await page.getByRole("button", { name: "保存配置" }).click();
  await expect(page.getByRole("heading", { name: "登录创序 OCC" })).toBeVisible();
  await page.getByLabel("用户名").fill("smoke-operator");
  await page.getByLabel("密码").fill("correct-horse-battery");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByRole("heading", { name: "运行总览" })).toBeVisible();
}

async function openMyWork(page: Page, taskName: string): Promise<void> {
  await page.getByRole("link", { name: "我的工作", exact: true }).click();
  await expect(page.getByRole("heading", { name: "我的工作", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: taskName, exact: true })).toBeVisible();
}

test("packaged smoke exercises persisted offline recovery, SSE resume, conflict refresh, and streamed evidence", async () => {
  const executable = await smokeExecutable();
  const userData = await mkdtemp(path.join(tmpdir(), "innorder-reliability-"));
  const server = await startReliabilityServer();
  let application: ElectronApplication | undefined;

  try {
    let launched = await launch(executable, userData);
    application = launched.application;
    let page = launched.page;
    await bootstrap(page, server);
    await openMyWork(page, "Reliability task v1");

    await expect.poll(() => server.state.requests.filter(({ path: value }) => value === "/api/v1/workspaces/my-work/query").length).toBeGreaterThan(0);
    const liveEvent = page.evaluate(() => new Promise<{ title: string }>((resolve) => {
      const dispose = window.occ.notifications.subscribe((event) => {
        dispose();
        resolve({ title: event.title });
      });
    }));
    await expect.poll(() => server.state.lastEventIds.length).toBeGreaterThan(0);
    server.queueNotification({ title: "Live reliability event" });
    await expect(liveEvent).resolves.toEqual({ title: "Live reliability event" });

    await application.close();
    application = undefined;
    launched = await launch(executable, userData);
    application = launched.application;
    page = launched.page;
    await expect(page.getByRole("heading", { name: "运行总览" })).toBeVisible();
    await openMyWork(page, "Reliability task v1");

    const identity = await application.evaluate(({ app }) => ({ name: app.getName(), executablePath: process.execPath }));
    expect({ name: identity.name, executable: path.basename(identity.executablePath) }).toEqual({ name: "Innorder OCC Smoke", executable: "InnorderOCCSmoke.exe" });

    await server.stop();
    server.queueNotification({ title: "Missed reliability event" });
    await page.evaluate(async () => {
      await window.occ.runtime.statuses();
      window.dispatchEvent(new Event("offline"));
    });
    await expect(page.getByRole("status", { name: "连接状态更新" })).toContainText("离线");
    const stale = await page.evaluate(() => window.occ.workspaces.query({ workspace: "my-work", operation: "tasks.query" }));
    expect(stale).toMatchObject({ state: "stale", items: [{ task: "Reliability task v1" }] });
    const offlineMutation = await page.evaluate(async () => {
      try {
        await window.occ.commands.execute({ workspace: "my-work", operation: "claim", targetId: "task-1", payload: { taskId: "task-1" }, intentHandle: "60000000-0000-4000-8000-000000000001" });
        return "accepted";
      } catch {
        return "offline";
      }
    });
    expect(offlineMutation).toBe("offline");

    server.setWorkspaceGeneration(2);
    await server.start();
    await expect.poll(() => server.state.notificationListCursors.includes("cursor-1"), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => server.state.lastEventIds.includes("cursor-2"), { timeout: 15_000 }).toBe(true);
    await page.evaluate(async () => {
      await window.occ.runtime.statuses();
      window.dispatchEvent(new Event("online"));
    });
    await expect(page.getByRole("cell", { name: "Reliability task v2", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "选择任务：Reliability task v2" }).click();
    const queryCount = server.state.requests.filter(({ path: value }) => value === "/api/v1/workspaces/my-work/query").length;
    await page.getByRole("button", { name: "领取任务", exact: true }).click();
    await expect(page.getByRole("status", { name: "命令回执" })).toContainText("当前版本 7");
    await page.getByRole("button", { name: "刷新当前版本" }).click();
    await expect.poll(() => server.state.requests.filter(({ path: value }) => value === "/api/v1/workspaces/my-work/query").length).toBeGreaterThan(queryCount);

    const evidence = Buffer.alloc(1024 * 1024 + 17, 0x61);
    await page.getByLabel("选择证据文件").setInputFiles({ name: "evidence.txt", mimeType: "text/plain", buffer: evidence });
    await page.getByRole("button", { name: "开始上传" }).click();
    await expect(page.getByRole("status", { name: "证据上传完成" })).toContainText("40000000-0000-4000-8000-000000000001");
    expect(server.state.upload).toMatchObject({ bytes: evidence.length, chunks: 5 });

    const smokeAsar = await readFile(path.join(path.dirname(executable), "resources", "app.asar"));
    expect(smokeAsar.toString("utf8")).not.toContain("OCC_SMOKE_FIXTURE");
    expect(server.state.requests.some(({ idempotencyKey }) => idempotencyKey !== undefined)).toBe(true);
  } finally {
    await application?.close().catch(() => undefined);
    await server.close();
    await rm(userData, { recursive: true, force: true });
  }
});
