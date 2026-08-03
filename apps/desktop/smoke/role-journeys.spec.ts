import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, test, type Page } from "playwright/test";

import { packagedSmokeLaunchOptions, preflightPackagedExecutable } from "./packaged-app";
import { assertNoSeriousAxeViolations, ids, launchSmokeFixture, roleCapabilities, type SmokeFixture } from "./fixtures/smoke-adapter";

interface ExpectedCommand {
  readonly workspace: string;
  readonly operation: string;
  readonly payload: Record<string, unknown>;
  readonly targetId?: string;
}

async function submitCompleted(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name, exact: true }).click();
  const receipt = page.getByRole("status", { name: "命令回执" }).last();
  await expect(receipt).toContainText("命令已完成");
  await expect(receipt).toContainText(ids.correlation);
}

async function expectExactCommands(fixture: SmokeFixture, expected: readonly ExpectedCommand[]): Promise<void> {
  const commands = (await fixture.calls())
    .filter(({ channel }) => channel === "commands:execute")
    .map(({ input }) => {
      const command = input as ExpectedCommand & { intentHandle: string };
      expect(command.intentHandle).toMatch(/^[0-9a-f-]{36}$/i);
      return {
        workspace: command.workspace,
        operation: command.operation,
        payload: command.payload,
        ...(command.targetId ? { targetId: command.targetId } : {}),
      };
    });
  expect(commands).toEqual(expected);
}

test("production ASAR contains no smoke adapter and cannot activate one", async () => {
  const executable = await preflightPackagedExecutable();
  const asar = await readFile(path.join(path.dirname(executable), "resources", "app.asar"));
  const packagedText = asar.toString("utf8");
  for (const marker of ["smoke-adapter", "__occSmokeFixture", "roleCapabilities", "OCC_SMOKE_FIXTURE"]) {
    expect(packagedText).not.toContain(marker);
  }
  const userData = await mkdtemp(path.join(tmpdir(), "innorder-no-fixture-"));
  await writeFile(path.join(userData, "occ-smoke-fixture.json"), JSON.stringify({ enabled: true, role: "administrator" }));
  const launchOptions = packagedSmokeLaunchOptions(executable, [`--user-data-dir=${userData}`, "--occ-smoke-fixture=administrator"]);
  if (!launchOptions) throw new Error("Packaged launch options are unavailable");
  const application = await electron.launch({
    ...launchOptions,
    env: { ...launchOptions.env, OCC_SMOKE_FIXTURE: "administrator", OCC_ROLE_DATA: "enabled" },
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole("heading", { name: "连接服务器" })).toBeVisible();
    expect(await application.evaluate(() => "__occSmokeFixture" in globalThis)).toBe(false);
  } finally {
    await application.close();
    await rm(userData, { recursive: true, force: true });
  }
});

test("administrator bootstraps HTTPS profile, logs in, and executes the exact administration contract", async () => {
  const fixture = await launchSmokeFixture({ role: "administrator", startWithoutProfile: true });
  try {
    const { page } = fixture;
    await expect(page.getByRole("heading", { name: "连接服务器" })).toBeVisible();
    await page.getByLabel("配置名称").fill("Pilot OCC");
    await page.getByLabel("服务器源地址（精确 origin）").fill("https://pilot.example.test");
    await page.getByLabel("环境").selectOption("pilot");
    await page.getByRole("button", { name: "保存配置" }).click();
    await expect(page.getByRole("heading", { name: "登录创序 OCC" })).toBeVisible();
    await page.getByLabel("用户名").fill("pilot-admin");
    await page.getByLabel("密码").fill("generic-password-value");
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByRole("heading", { name: "运行总览" })).toBeVisible();
    await page.getByRole("link", { name: "管理", exact: true }).click();
    await expect(page.getByRole("heading", { name: "管理", exact: true })).toBeFocused();

    await page.getByLabel("人员姓名").fill("Pilot Person");
    await page.getByLabel("人员邮箱").fill("person@example.test");
    await submitCompleted(page, "创建人员");
    await page.getByRole("tab", { name: "关系" }).click();
    await page.getByLabel("关系主体 ID").fill("person-1"); await page.getByLabel("关系对象 ID").fill("person-2"); await page.getByLabel("关系类型").fill("manager");
    await submitCompleted(page, "分配关系");
    await page.getByRole("tab", { name: "角色" }).click();
    await page.getByLabel("人员 ID").fill("person-1"); await page.getByLabel("角色 ID").fill("role-admin"); await submitCompleted(page, "分配角色");
    await page.getByRole("tab", { name: "策略发布" }).click();
    await page.getByLabel("策略发布 ID").fill("policy-1"); await page.getByLabel("策略版本").fill("3"); await page.getByLabel("已批准发布").check(); await submitCompleted(page, "发布策略");
    await page.getByRole("tab", { name: "智能服务" }).click();
    await page.getByLabel("服务配置 ID").fill("provider-1"); await page.getByLabel("服务地址").fill("https://ai.example.test"); await page.getByLabel("服务模型").fill("pilot-model"); await page.getByLabel("服务密钥").fill("provider-secret-value"); await submitCompleted(page, "测试智能服务");
    await page.getByRole("tab", { name: "知识" }).click();
    await page.getByLabel("上传引用").fill("knowledge/upload-1"); await page.getByLabel("知识目标").fill("pilot"); await submitCompleted(page, "导入知识");
    await page.getByRole("tab", { name: "审计" }).click(); await page.getByLabel("审计目标").fill("person-1"); await submitCompleted(page, "检查审计");
    await page.getByRole("tab", { name: "智能服务" }).click();
    await expect(page.getByLabel("服务密钥")).toHaveValue("");
    await assertNoSeriousAxeViolations(page);

    const calls = await fixture.calls();
    expect(calls).toContainEqual({ channel: "profiles:save", input: { name: "Pilot OCC", origin: "https://pilot.example.test", environment: "pilot" } });
    expect(calls).toContainEqual({ channel: "session:login", input: { username: "pilot-admin", password: "[REDACTED]" } });
    await expectExactCommands(fixture, [
      { workspace: "administration", operation: "create", payload: { name: "Pilot Person", email: "person@example.test" } },
      { workspace: "administration", operation: "assignRelationship", payload: { relatedPersonId: "person-2", relationshipType: "manager" }, targetId: "person-1" },
      { workspace: "administration", operation: "assign", payload: { roleId: "role-admin" }, targetId: "person-1" },
      { workspace: "administration", operation: "release", payload: { expectedVersion: 3, approved: true }, targetId: "policy-1" },
      { workspace: "administration", operation: "test", payload: { endpoint: "https://ai.example.test", model: "pilot-model", secret: "[REDACTED]" }, targetId: "provider-1" },
      { workspace: "administration", operation: "ingest", payload: { uploadRef: "knowledge/upload-1", target: "pilot" }, targetId: "pilot" },
      { workspace: "administration", operation: "inspect", payload: { target: "person-1" }, targetId: "person-1" },
    ]);
    expect(JSON.stringify(calls)).not.toContain("generic-password-value");
    expect(JSON.stringify(calls)).not.toContain("provider-secret-value");
  } finally {
    await fixture.close();
  }
});

test("participant claims explicit work, uploads evidence, reserves resources, and keeps AI controls honest", async () => {
  const fixture = await launchSmokeFixture({ role: "participant" });
  try {
    const { page } = fixture;
    await page.getByRole("link", { name: "我的工作", exact: true }).click();
    await expect(page.getByRole("cell", { name: "Submit identity evidence", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "选择任务：Submit identity evidence" }).click();
    await expect(page.getByText("Signed checklist")).toBeVisible();
    await submitCompleted(page, "领取任务");
    const evidenceBytes = 1536 * 1024 + 17;
    await page.getByLabel("选择证据文件").setInputFiles({ name: "evidence.txt", mimeType: "text/plain", buffer: Buffer.alloc(evidenceBytes, 0x61) });
    await page.getByLabel("提交说明").fill("Signed"); await page.getByRole("button", { name: "开始上传", exact: true }).click();
    const evidenceProgress = page.getByRole("progressbar", { name: "evidence.txt 上传进度" });
    await expect(evidenceProgress).toBeVisible();
    await expect(evidenceProgress).toHaveJSProperty("value", 67);
    await expect(page.getByRole("status", { name: "证据上传完成" })).toBeVisible();
    const successfulUploadCalls = (await fixture.calls()).filter(({ channel }) => channel.startsWith("uploads:"));
    expect(successfulUploadCalls.filter(({ channel }) => channel === "uploads:append").map(({ input }) => input)).toEqual([
      { uploadId: ids.upload, sequence: 0, data: "[BINARY]" },
      { uploadId: ids.upload, sequence: 1, data: "[BINARY]" },
    ]);
    expect(successfulUploadCalls.filter(({ channel }) => channel === "uploads:finish")).toEqual([{ channel: "uploads:finish", input: ids.upload }]);
    await submitCompleted(page, "提交证据");
    await page.getByLabel("资源 ID").fill("resource-1"); await page.getByLabel("开始时间").fill("2026-08-03T08:00"); await page.getByLabel("结束时间").fill("2026-08-03T09:00"); await submitCompleted(page, "预留资源");
    await page.getByLabel("问题").fill("What is required?"); await submitCompleted(page, "请求智能建议");
    await expect(page.getByText("已退回").first()).toBeVisible();
    await expect(page.getByText("智能建议 API 合同尚未集成").first()).toBeVisible();
    await expect(page.getByText("建议仅供参考，不能替代流程、证据、审核或权限决定。")).toBeVisible();
    await assertNoSeriousAxeViolations(page);
    await page.getByRole("tab", { name: "已退回" }).click();
    await expect(page.getByRole("cell", { name: "RETURNED", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "已完成" }).click();
    await expect(page.getByRole("cell", { name: "COMPLETED", exact: true })).toBeVisible();
    await page.getByRole("link", { name: "介入中心", exact: true }).click();
    await expect(page.getByText("Pilot handbook section 4.2")).toBeVisible();
    await assertNoSeriousAxeViolations(page);
    await expectExactCommands(fixture, [
      { workspace: "my-work", operation: "claim", payload: { taskId: "task-1" }, targetId: "task-1" },
      { workspace: "my-work", operation: "submitEvidence", payload: { taskId: "task-1", note: "Signed", uploadReference: "quarantine/evidence-1" }, targetId: "task-1" },
      { workspace: "my-work", operation: "reserve", payload: { taskId: "task-1", resourceId: "resource-1", startsAt: "2026-08-03T08:00", endsAt: "2026-08-03T09:00" }, targetId: "task-1" },
      { workspace: "my-work", operation: "guidance", payload: { taskId: "task-1", question: "What is required?" }, targetId: "task-1" },
    ]);

    await page.getByRole("link", { name: "我的工作", exact: true }).click();
    await page.getByRole("button", { name: "选择任务：Submit identity evidence" }).click();
    await fixture.setUploadPaused(true);
    await page.getByLabel("选择证据文件").setInputFiles({ name: "cancel.txt", mimeType: "text/plain", buffer: Buffer.alloc(evidenceBytes, 0x62) });
    await page.getByRole("button", { name: "开始上传", exact: true }).click();
    await expect(page.getByRole("button", { name: "取消上传", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "取消上传", exact: true }).click();
    await expect.poll(async () => (await fixture.calls()).filter(({ channel }) => channel === "uploads:cancel").length).toBe(1);
    await fixture.setUploadPaused(false);
    await expect(page.getByRole("status", { name: "证据上传失败" })).toBeVisible();

    const protocolRejections = await page.evaluate(async ({ uploadId }) => {
      const metadata = { workspace: "my-work", taskId: "task-1", fileName: "bad.txt", mediaType: "text/plain", size: 2, intentHandle: crypto.randomUUID() };
      await window.occ.uploads.begin(metadata);
      const outOfOrder = await window.occ.uploads.append({ uploadId, sequence: 1, data: new Uint8Array([1]) }).then(() => false, () => true);
      const oversized = await window.occ.uploads.append({ uploadId, sequence: 0, data: new Uint8Array(1024 * 1024 + 1) }).then(() => false, () => true);
      await window.occ.uploads.append({ uploadId, sequence: 0, data: new Uint8Array([1]) });
      const sizeMismatch = await window.occ.uploads.finish(uploadId).then(() => false, () => true);
      await window.occ.uploads.cancel(uploadId);
      return { outOfOrder, oversized, sizeMismatch };
    }, { uploadId: ids.upload });
    expect(protocolRejections).toEqual({ outOfOrder: true, oversized: true, sizeMismatch: true });
  } finally { await fixture.close(); }
});

test("domain modeler uploads ZIP and performs validate, diff, approve, and publish with duty separation", async () => {
  const fixture = await launchSmokeFixture({ role: "modeler" });
  try {
    const { page } = fixture;
    await page.getByRole("link", { name: "领域设计", exact: true }).click();
    await expect(page.getByText("pilot-operations")).toBeVisible();
    await expect(page.getByText(/批准人与导入或修改该版本的人员必须不同/)).toBeVisible();
    await page.getByLabel("包名称").fill("pilot-operations"); await page.getByLabel("包版本").fill("1.4.0"); await page.getByLabel("包类型").fill("process");
    const zip = Buffer.alloc(1536 * 1024 + 17); zip.set([0x50, 0x4b, 0x05, 0x06]);
    await page.getByLabel("签名领域包归档").setInputFiles({ name: "pilot.zip", mimeType: "application/zip", buffer: zip });
    await expect(page.getByRole("progressbar", { name: "归档上传进度" })).toHaveJSProperty("value", 0);
    await page.getByRole("button", { name: "上传归档" }).click();
    await expect(page.getByRole("region", { name: "归档上传引用" })).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "归档上传进度" })).toHaveJSProperty("value", 100);
    const uploadCalls = (await fixture.calls()).filter(({ channel }) => channel.startsWith("uploads:"));
    expect(uploadCalls.filter(({ channel }) => channel === "uploads:append").map(({ input }) => input)).toEqual([
      { uploadId: ids.upload, sequence: 0, data: "[BINARY]" },
      { uploadId: ids.upload, sequence: 1, data: "[BINARY]" },
    ]);
    expect(uploadCalls.filter(({ channel }) => channel === "uploads:finish")).toEqual([{ channel: "uploads:finish", input: ids.upload }]);
    await submitCompleted(page, "导入");
    await page.getByLabel("领域包编号").fill("package-1"); await page.getByLabel("版本编号").fill("version-1");
    await submitCompleted(page, "校验"); await page.getByLabel("比较基准版本").fill("1.3.0"); await submitCompleted(page, "比较版本");
    await page.getByLabel("预期版本").fill("4"); await submitCompleted(page, "批准"); await submitCompleted(page, "发布");
    await assertNoSeriousAxeViolations(page);
    await expectExactCommands(fixture, [
      { workspace: "domain-design", operation: "import", payload: { packageName: "pilot-operations", packageVersion: "1.4.0", packageType: "process", uploadId: ids.upload, sha256: "a".repeat(64) } },
      { workspace: "domain-design", operation: "validate", payload: { packageId: "package-1" }, targetId: "version-1" },
      { workspace: "domain-design", operation: "diff", payload: { packageId: "package-1", baseVersion: "1.3.0" }, targetId: "version-1" },
      { workspace: "domain-design", operation: "approve", payload: { expectedVersion: 4 }, targetId: "version-1" },
      { workspace: "domain-design", operation: "publish", payload: { expectedVersion: 4 }, targetId: "version-1" },
    ]);
  } finally { await fixture.close(); }
});

test("resource manager covers inventory, reservations, redacted conflicts, and 409 refresh", async () => {
  const fixture = await launchSmokeFixture({ role: "resource-manager" });
  try {
    const { page } = fixture;
    await page.getByRole("link", { name: "资源", exact: true }).click();
    await expect(page.getByText("Assembly line A")).toBeVisible();
    await page.getByRole("tab", { name: "冲突" }).click();
    await expect(page.getByText("参与者信息已按权限隐藏")).toBeVisible();
    await page.getByLabel("资源名称").fill("Assembly line B"); await page.getByLabel("新资源类型").fill("line"); await page.getByRole("spinbutton", { name: "容量", exact: true }).fill("8"); await submitCompleted(page, "创建资源");
    await page.getByLabel("预留资源编号").fill("resource-1"); await page.getByLabel("开始时间").fill("2026-08-03T08:00"); await page.getByLabel("结束时间").fill("2026-08-03T09:00"); await page.getByLabel("预留容量").fill("2"); await page.getByLabel("资源预期版本").fill("2"); await submitCompleted(page, "创建预留");
    await page.getByLabel("预留编号").fill("reservation-1"); await page.getByLabel("预留版本").fill("1"); await submitCompleted(page, "取消预留");
    await page.getByLabel("变更资源编号").fill("resource-1"); await page.getByLabel("当前版本").fill("2"); await page.getByLabel("新容量").fill("14"); await submitCompleted(page, "变更资源");
    await page.getByLabel("当前版本").fill("1"); await expect(page.getByRole("button", { name: "变更资源" })).toBeEnabled(); await page.getByRole("button", { name: "变更资源" }).click(); await expect(page.getByText("版本冲突").last()).toBeVisible();
    await expect(page.getByRole("status", { name: "命令回执" }).last()).toContainText(ids.correlation);
    await fixture.setQueryState("resources", "conflict");
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(page.getByRole("region", { name: "版本冲突" })).toContainText(`当前版本 9`);
    await expect(page.getByRole("region", { name: "版本冲突" })).toContainText(ids.correlation);
    await expect(page.getByRole("button", { name: "刷新当前版本" })).toBeVisible();
    await assertNoSeriousAxeViolations(page);
    await expectExactCommands(fixture, [
      { workspace: "resources", operation: "create", payload: { name: "Assembly line B", type: "line", capacity: 8 } },
      { workspace: "resources", operation: "reserve", payload: { start: "2026-08-03T00:00:00.000Z", end: "2026-08-03T01:00:00.000Z", capacity: 2, expectedVersion: 2, exclusive: false }, targetId: "resource-1" },
      { workspace: "resources", operation: "cancel", payload: { expectedVersion: 1 }, targetId: "reservation-1" },
      { workspace: "resources", operation: "change", payload: { expectedVersion: 2, capacity: 14 }, targetId: "resource-1" },
      { workspace: "resources", operation: "change", payload: { expectedVersion: 1, capacity: 14 }, targetId: "resource-1" },
    ]);
  } finally { await fixture.close(); }
});

test("offline and reconnect keep stale reads, reject mutation, resume notifications, and validate session", async () => {
  const fixture = await launchSmokeFixture({ role: "participant" });
  try {
    const { page } = fixture;
    await page.getByRole("link", { name: "我的工作", exact: true }).click();
    await expect(page.getByRole("cell", { name: "Submit identity evidence", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "选择任务：Submit identity evidence" }).click();
    const commandsBeforeOffline = (await fixture.calls()).filter(({ channel }) => channel === "commands:execute").length;
    await fixture.setOnline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expect(page.getByText("离线数据，只读")).toBeVisible();
    await expect(page.getByText(/数据年龄/)).toBeVisible();
    await expect(page.getByRole("button", { name: "领取任务", exact: true })).toBeDisabled();
    expect((await fixture.calls()).filter(({ channel }) => channel === "commands:execute")).toHaveLength(commandsBeforeOffline);
    await fixture.sendNotificationState("reconnecting");
    await expect(page.getByRole("status", { name: "通知同步延迟" })).toBeVisible();
    expect(await page.evaluate(() => window.occ.notifications.list("cursor-1"))).toMatchObject({ nextCursor: "cursor-2", items: [{ cursor: "cursor-1", read: false }] });
    await fixture.setOnline(true);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.getByText(/正在重新连接|重新连接/).first()).toBeVisible();
    await expect(page.getByRole("cell", { name: "Submit identity evidence", exact: true })).toBeVisible();
    await fixture.sendNotificationState("online");
    await expect(page.getByRole("status", { name: "通知同步延迟" })).toHaveCount(0);
    expect((await fixture.calls()).filter(({ channel }) => channel === "session:restore").length).toBeGreaterThanOrEqual(2);
    await assertNoSeriousAxeViolations(page);
  } finally { await fixture.close(); }
});

for (const role of ["administrator", "teacher", "participant", "modeler", "resource-manager"] as const) {
  test(`capability matrix isolates routes and direct queries for ${role}`, async () => {
    const fixture = await launchSmokeFixture({ role });
    try {
      const { page } = fixture;
      const nav = page.getByRole("navigation", { name: "主导航" });
      const mayAdminister = roleCapabilities[role].includes("occ.admin");
      const expectedRoutes = mayAdminister
        ? ["总览", "我的工作", "流程", "介入中心", "风险", "资源", "领域设计", "管理", "系统", "设置"]
        : ["总览", "我的工作", "流程", "介入中心", "风险", "资源", "系统", "设置"];
      await expect(nav.getByRole("link")).toHaveText(expectedRoutes);
      await expect(page.getByText("Pilot order exception", { exact: true })).toBeVisible();
      const denied = role === "administrator"
        ? { workspace: "risks", query: "risks.query", command: "acknowledge" }
        : { workspace: "administration", query: "administration.query", command: "create" };
      const directDenials = await page.evaluate(async (request) => ({
        query: await window.occ.workspaces.query({ workspace: request.workspace, operation: request.query, filters: {}, limit: 25 }),
        command: await window.occ.commands.execute({ workspace: request.workspace, operation: request.command, payload: {}, intentHandle: crypto.randomUUID() }),
      }), denied);
      expect(directDenials.query).toMatchObject({ state: "error", problem: { status: 403, code: "OPERATION_FORBIDDEN" } });
      expect(directDenials.command).toMatchObject({ state: "problem", problem: { status: 403, code: "OPERATION_FORBIDDEN" } });
      if (!mayAdminister) {
        const before = (await fixture.calls()).filter(({ channel }) => channel === "workspaces:query").length;
        await page.evaluate(() => { window.location.hash = "/administration"; });
        await expect(page.getByRole("heading", { name: "访问被拒绝" })).toBeFocused();
        const after = (await fixture.calls()).filter(({ channel }) => channel === "workspaces:query").length;
        expect(after).toBe(before);
      }
    } finally { await fixture.close(); }
  });
}

test("keyboard-only navigation focuses the route and activates its primary refresh command", async () => {
  const fixture = await launchSmokeFixture({ role: "participant" });
  try {
    const { page } = fixture;
    expect(await page.locator("body").evaluate((body) => document.activeElement === body)).toBe(true);
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "总览", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "我的工作", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("link", { name: "总览", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "我的工作" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("tab", { name: "可领取" })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "已领取" })).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByRole("tab", { name: "可领取" })).toBeFocused();
    for (let index = 0; index < 5; index += 1) await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeFocused();
    const queriesBeforeRefresh = (await fixture.calls()).filter(({ channel }) => channel === "workspaces:query").length;
    await page.keyboard.press("Enter");
    await expect(page.getByRole("cell", { name: "Submit identity evidence", exact: true })).toBeVisible();
    await expect.poll(async () => (await fixture.calls()).filter(({ channel }) => channel === "workspaces:query").length).toBe(queriesBeforeRefresh + 1);
  } finally { await fixture.close(); }
});

test("teacher journey exposes process, review, risk, conflict, and correlation receipts", async () => {
  const fixture = await launchSmokeFixture({ role: "teacher" });
  try {
    const { page } = fixture;
    await page.getByRole("link", { name: "流程", exact: true }).click();
    await expect(page.getByRole("cell", { name: "Pilot onboarding", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "选择流程：Pilot onboarding" }).click(); await page.getByLabel("群组名称").fill("September cohort"); await submitCompleted(page, "创建群组"); await page.getByLabel("流程定义").fill("pilot-v1"); await submitCompleted(page, "启动流程");
    await page.getByRole("link", { name: "介入中心", exact: true }).click();
    await expect(page.getByText("Pilot handbook section 4.2")).toBeVisible();
    await page.getByRole("button", { name: "选择介入事项：Identity evidence review" }).click(); await submitCompleted(page, "接受"); await page.getByLabel("有条件接受后续要求").fill("Add signature"); await page.getByLabel("有条件接受到期日").fill("2026-08-05"); await submitCompleted(page, "有条件接受"); await submitCompleted(page, "拒绝");
    await page.getByRole("link", { name: "风险", exact: true }).click();
    await expect(page.getByText("Participant deadline at risk")).toBeVisible();
    await page.getByRole("button", { name: "选择风险：Participant deadline at risk" }).click(); await page.getByLabel("预期风险版本").fill("5"); await submitCompleted(page, "确认风险"); await page.getByLabel("缓解措施").fill("Daily review"); await submitCompleted(page, "记录缓解"); await page.getByLabel("解决说明").fill("Evidence accepted"); await submitCompleted(page, "解决风险");
    await assertNoSeriousAxeViolations(page);
    await expectExactCommands(fixture, [
      { workspace: "processes", operation: "create", payload: { name: "September cohort" } },
      { workspace: "processes", operation: "start", payload: { processDefinition: "pilot-v1", processId: "process-1" }, targetId: "process-1" },
      { workspace: "interventions", operation: "accept", payload: { evidenceVersion: 3, expectedVersion: 4 }, targetId: "review-1" },
      { workspace: "interventions", operation: "conditional", payload: { evidenceVersion: 3, expectedVersion: 4, followUp: "Add signature", dueAt: "2026-08-05" }, targetId: "review-1" },
      { workspace: "interventions", operation: "reject", payload: { evidenceVersion: 3, expectedVersion: 4 }, targetId: "review-1" },
      { workspace: "risks", operation: "acknowledge", payload: { expectedVersion: 5 }, targetId: "risk-1" },
      { workspace: "risks", operation: "mitigate", payload: { expectedVersion: 5, mitigation: "Daily review" }, targetId: "risk-1" },
      { workspace: "risks", operation: "resolve", payload: { expectedVersion: 5, resolution: "Evidence accepted" }, targetId: "risk-1" },
    ]);
  } finally {
    await fixture.close();
  }
});
