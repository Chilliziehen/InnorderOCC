import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, test } from "playwright/test";

import { packagedSmokeLaunchOptions, preflightPackagedExecutable } from "./packaged-app";
import { assertNoSeriousAxeViolations, executeFixtureCommand, ids, launchSmokeFixture, roleCapabilities } from "./fixtures/smoke-adapter";

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
    await page.getByRole("button", { name: "创建人员" }).click();
    await page.getByRole("tab", { name: "关系" }).click();
    await page.getByLabel("关系主体 ID").fill("person-1"); await page.getByLabel("关系对象 ID").fill("person-2"); await page.getByLabel("关系类型").fill("manager");
    await page.getByRole("button", { name: "分配关系" }).click();
    await page.getByRole("tab", { name: "角色" }).click();
    await page.getByLabel("人员 ID").fill("person-1"); await page.getByLabel("角色 ID").fill("role-admin"); await page.getByRole("button", { name: "分配角色" }).click();
    await page.getByRole("tab", { name: "策略发布" }).click();
    await page.getByLabel("策略发布 ID").fill("policy-1"); await page.getByLabel("策略版本").fill("3"); await page.getByLabel("已批准发布").check(); await page.getByRole("button", { name: "发布策略" }).click();
    await page.getByRole("tab", { name: "智能服务" }).click();
    await page.getByLabel("服务配置 ID").fill("provider-1"); await page.getByLabel("服务地址").fill("https://ai.example.test"); await page.getByLabel("服务模型").fill("pilot-model"); await page.getByLabel("服务密钥").fill("provider-secret-value"); await page.getByRole("button", { name: "测试智能服务" }).click();
    await page.getByRole("tab", { name: "知识" }).click();
    await page.getByLabel("上传引用").fill("knowledge/upload-1"); await page.getByLabel("知识目标").fill("pilot"); await page.getByRole("button", { name: "导入知识" }).click();
    await page.getByRole("tab", { name: "审计" }).click(); await page.getByLabel("审计目标").fill("person-1"); await page.getByRole("button", { name: "检查审计" }).click();
    await page.getByRole("tab", { name: "智能服务" }).click();
    await expect(page.getByLabel("服务密钥")).toHaveValue("");
    await assertNoSeriousAxeViolations(page);

    const calls = await fixture.calls();
    expect(calls).toContainEqual({ channel: "profiles:save", input: { name: "Pilot OCC", origin: "https://pilot.example.test", environment: "pilot" } });
    expect(calls).toContainEqual({ channel: "session:login", input: { username: "pilot-admin", password: "[REDACTED]" } });
    expect(calls).toContainEqual(expect.objectContaining({ channel: "commands:execute", input: expect.objectContaining({ workspace: "administration", operation: "create", payload: { name: "Pilot Person", email: "person@example.test" } }) }));
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
    await page.getByRole("button", { name: "领取任务" }).click();
    await page.getByLabel("选择证据文件").setInputFiles({ name: "evidence.txt", mimeType: "text/plain", buffer: Buffer.alloc(1024 * 1024 + 17, 0x61) });
    await page.getByLabel("提交说明").fill("Signed"); await page.getByRole("button", { name: "开始上传" }).click();
    await expect(page.getByRole("status", { name: "证据上传完成" })).toBeVisible(); await page.getByRole("button", { name: "提交证据" }).click();
    await page.getByLabel("资源 ID").fill("resource-1"); await page.getByLabel("开始时间").fill("2026-08-03T08:00"); await page.getByLabel("结束时间").fill("2026-08-03T09:00"); await page.getByRole("button", { name: "预留资源" }).click();
    await page.getByLabel("问题").fill("What is required?"); await page.getByRole("button", { name: "请求智能建议" }).click();
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
    const zip = Buffer.alloc(1024 * 1024 + 17); zip.set([0x50, 0x4b, 0x05, 0x06]);
    await page.getByLabel("签名领域包归档").setInputFiles({ name: "pilot.zip", mimeType: "application/zip", buffer: zip });
    await page.getByRole("button", { name: "上传归档" }).click();
    await expect(page.getByRole("region", { name: "归档上传引用" })).toBeVisible(); await page.getByRole("button", { name: "导入" }).click();
    await page.getByLabel("领域包编号").fill("package-1"); await page.getByLabel("版本编号").fill("version-1");
    await page.getByRole("button", { name: "校验" }).click(); await page.getByLabel("比较基准版本").fill("1.3.0"); await page.getByRole("button", { name: "比较版本" }).click();
    await page.getByLabel("预期版本").fill("4"); await page.getByRole("button", { name: "批准" }).click(); await page.getByRole("button", { name: "发布" }).click();
    await assertNoSeriousAxeViolations(page);
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
    await page.getByLabel("资源名称").fill("Assembly line B"); await page.getByLabel("新资源类型").fill("line"); await page.getByRole("spinbutton", { name: "容量", exact: true }).fill("8"); await page.getByRole("button", { name: "创建资源" }).click();
    await page.getByLabel("预留资源编号").fill("resource-1"); await page.getByLabel("开始时间").fill("2026-08-03T08:00"); await page.getByLabel("结束时间").fill("2026-08-03T09:00"); await page.getByLabel("预留容量").fill("2"); await page.getByLabel("资源预期版本").fill("2"); await page.getByRole("button", { name: "创建预留" }).click();
    await page.getByLabel("预留编号").fill("reservation-1"); await page.getByLabel("预留版本").fill("1"); await page.getByRole("button", { name: "取消预留" }).click();
    await page.getByLabel("变更资源编号").fill("resource-1"); await page.getByLabel("当前版本").fill("2"); await page.getByLabel("新容量").fill("14"); await page.getByRole("button", { name: "变更资源" }).click();
    await expect(page.getByRole("status", { name: "命令回执" }).last()).toContainText("命令已完成");
    await page.getByLabel("当前版本").fill("1"); await expect(page.getByRole("button", { name: "变更资源" })).toBeEnabled(); await page.getByRole("button", { name: "变更资源" }).click(); await expect(page.getByText("版本冲突").last()).toBeVisible();
    await fixture.setQueryState("resources", "conflict");
    await page.getByRole("button", { name: "刷新" }).click();
    await expect(page.getByRole("region", { name: "版本冲突" })).toContainText(`当前版本 9`);
    await expect(page.getByRole("region", { name: "版本冲突" })).toContainText(ids.correlation);
    await expect(page.getByRole("button", { name: "刷新当前版本" })).toBeVisible();
    await assertNoSeriousAxeViolations(page);
  } finally { await fixture.close(); }
});

test("offline and reconnect keep stale reads, reject mutation, resume notifications, and validate session", async () => {
  const fixture = await launchSmokeFixture({ role: "participant" });
  try {
    const { page } = fixture;
    await page.getByRole("link", { name: "我的工作", exact: true }).click();
    await expect(page.getByRole("cell", { name: "Submit identity evidence", exact: true })).toBeVisible();
    await fixture.setOnline(false);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await expect(page.getByText("离线数据，只读")).toBeVisible();
    await expect(page.getByText(/数据年龄/)).toBeVisible();
    expect(await executeFixtureCommand(page, "my-work", "claim", { taskId: "task-1" }, "task-1")).toMatchObject({ state: "problem", problem: { code: "OFFLINE_READ_ONLY" } });
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
    await page.getByRole("link", { name: "我的工作", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "我的工作" })).toBeFocused();
    await page.getByRole("button", { name: "刷新" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("cell", { name: "Submit identity evidence", exact: true })).toBeVisible();
  } finally { await fixture.close(); }
});

test("teacher journey exposes process, review, risk, conflict, and correlation receipts", async () => {
  const fixture = await launchSmokeFixture({ role: "teacher" });
  try {
    const { page } = fixture;
    await page.getByRole("link", { name: "流程", exact: true }).click();
    await expect(page.getByRole("cell", { name: "Pilot onboarding", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "选择流程：Pilot onboarding" }).click(); await page.getByLabel("群组名称").fill("September cohort"); await page.getByRole("button", { name: "创建群组" }).click(); await page.getByLabel("流程定义").fill("pilot-v1"); await page.getByRole("button", { name: "启动流程" }).click();
    await page.getByRole("link", { name: "介入中心", exact: true }).click();
    await expect(page.getByText("Pilot handbook section 4.2")).toBeVisible();
    await page.getByRole("button", { name: "选择介入事项：Identity evidence review" }).click(); await page.getByRole("button", { name: "接受", exact: true }).click(); await page.getByLabel("有条件接受后续要求").fill("Add signature"); await page.getByLabel("有条件接受到期日").fill("2026-08-05"); await page.getByRole("button", { name: "有条件接受" }).click(); await page.getByRole("button", { name: "拒绝", exact: true }).click();
    await page.getByRole("link", { name: "风险", exact: true }).click();
    await expect(page.getByText("Participant deadline at risk")).toBeVisible();
    await page.getByRole("button", { name: "选择风险：Participant deadline at risk" }).click(); await page.getByLabel("预期风险版本").fill("5"); await page.getByRole("button", { name: "确认风险" }).click(); await page.getByLabel("缓解措施").fill("Daily review"); await page.getByRole("button", { name: "记录缓解" }).click(); await page.getByLabel("解决说明").fill("Evidence accepted"); await page.getByRole("button", { name: "解决风险" }).click();
    await assertNoSeriousAxeViolations(page);
  } finally {
    await fixture.close();
  }
});
