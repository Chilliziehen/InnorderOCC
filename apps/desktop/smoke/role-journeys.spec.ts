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
    await expect(page.getByRole("button", { name: "创建人员" })).toBeDisabled();
    await expect(page.getByText("人员创建 API 合同尚未集成").first()).toBeVisible();
    expect(await executeFixtureCommand(page, "administration", "create", { name: "Pilot Person", email: "person@example.test" })).toMatchObject({ state: "completed", correlationId: ids.correlation });
    for (const [operation, payload, targetId] of [
      ["assignRelationship", { relatedPersonId: "person-2", relationshipType: "manager" }, "person-1"],
      ["assign", { roleId: "role-admin" }, "person-1"],
      ["release", { expectedVersion: 3, approved: true }, "policy-1"],
      ["test", { endpoint: "https://ai.example.test", model: "pilot-model", secret: "provider-secret-value" }, "provider-1"],
      ["ingest", { uploadRef: "knowledge/upload-1", target: "pilot" }, "pilot"],
      ["inspect", { target: "person-1" }, "person-1"],
    ] as const) expect(await executeFixtureCommand(page, "administration", operation, payload, targetId)).toMatchObject({ state: "completed", correlationId: ids.correlation });
    await page.getByRole("tab", { name: "智能服务" }).click();
    await page.getByLabel("服务密钥").fill("provider-secret-value");
    await page.getByRole("tab", { name: "知识" }).click();
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
    expect(await executeFixtureCommand(page, "my-work", "claim", { taskId: "task-1" }, "task-1")).toMatchObject({ state: "completed" });
    const upload = await page.evaluate(async ({ uploadId }) => {
      const metadata = { workspace: "my-work", taskId: "task-1", fileName: "evidence.txt", mediaType: "text/plain", size: 12, intentHandle: crypto.randomUUID() };
      const progress: number[] = [];
      const dispose = window.occ.uploads.subscribeProgress((event) => progress.push(event.percent));
      const preflight = await window.occ.uploads.preflight(metadata);
      const begun = await window.occ.uploads.begin(metadata);
      const chunk = await window.occ.uploads.append({ uploadId, sequence: 0, data: new TextEncoder().encode("pilot proof") });
      const finished = await window.occ.uploads.finish(uploadId);
      await new Promise((resolve) => setTimeout(resolve, 25));
      dispose();
      return { preflight, begun, chunk, finished, progress };
    }, { uploadId: ids.upload });
    expect(upload).toMatchObject({
      preflight: { state: "available" }, begun: { state: "started", uploadId: ids.upload },
      chunk: { acceptedBytes: 11, receivedBytes: 11 },
      finished: { state: "completed", kind: "evidence", quarantineStatus: "quarantined", uploadReference: "quarantine/evidence-1" },
      progress: [92],
    });
    for (const [operation, payload] of [
      ["submitEvidence", { taskId: "task-1", uploadReference: "quarantine/evidence-1", note: "Signed" }],
      ["reserve", { taskId: "task-1", resourceId: "resource-1", startsAt: "2026-08-03T08:00:00.000Z", endsAt: "2026-08-03T09:00:00.000Z" }],
      ["guidance", { taskId: "task-1", question: "What is required?" }],
    ] as const) expect(await executeFixtureCommand(page, "my-work", operation, payload, "task-1")).toMatchObject({ state: "completed" });
    await expect(page.getByText("已退回").first()).toBeVisible();
    await expect(page.getByText("智能建议 API 合同尚未集成").first()).toBeVisible();
    await expect(page.getByText("建议仅供参考，不能替代流程、证据、审核或权限决定。")).toBeVisible();
    await assertNoSeriousAxeViolations(page);
    await page.getByRole("tab", { name: "已退回" }).click();
    await expect(page.getByRole("cell", { name: "RETURNED", exact: true })).toBeVisible();
    expect(await executeFixtureCommand(page, "my-work", "submitEvidence", { taskId: "task-1", uploadReference: "quarantine/evidence-1", note: "Resubmitted" }, "task-1")).toMatchObject({ state: "completed" });
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
    const archive = await page.evaluate(async ({ uploadId }) => {
      const metadata = { workspace: "domain-design", taskId: "package-import", fileName: "pilot.zip", mediaType: "application/zip", size: 4, intentHandle: crypto.randomUUID() };
      await window.occ.uploads.preflight(metadata); await window.occ.uploads.begin(metadata);
      await window.occ.uploads.append({ uploadId, sequence: 0, data: new Uint8Array([0x50, 0x4b, 0x03, 0x04]) });
      return window.occ.uploads.finish(uploadId);
    }, { uploadId: ids.upload });
    expect(archive).toMatchObject({ state: "completed", kind: "archive", sha256: "a".repeat(64) });
    for (const [operation, payload, target] of [
      ["import", { packageName: "pilot-operations", packageVersion: "1.4.0", packageType: "process", uploadId: ids.upload, sha256: "a".repeat(64) }],
      ["validate", { packageId: "package-1" }, "version-1"],
      ["diff", { packageId: "package-1", baseVersion: "1.3.0" }, "version-1"],
      ["approve", { expectedVersion: 4 }, "version-1"],
      ["publish", { expectedVersion: 4 }, "version-1"],
    ] as const) expect(await executeFixtureCommand(page, "domain-design", operation, payload, target)).toMatchObject({ state: "completed" });
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
    expect(await executeFixtureCommand(page, "resources", "create", { name: "Assembly line B", type: "line", capacity: 8 })).toMatchObject({ state: "completed" });
    expect(await executeFixtureCommand(page, "resources", "reserve", { start: "2026-08-03T08:00:00.000Z", end: "2026-08-03T09:00:00.000Z", capacity: 2, expectedVersion: 2, exclusive: false }, "resource-1")).toMatchObject({ state: "completed" });
    expect(await executeFixtureCommand(page, "resources", "cancel", { expectedVersion: 1 }, "reservation-1")).toMatchObject({ state: "completed" });
    expect(await executeFixtureCommand(page, "resources", "change", { expectedVersion: 2, capacity: 14 }, "resource-1")).toMatchObject({ state: "completed" });
    expect(await executeFixtureCommand(page, "resources", "change", { expectedVersion: 1, capacity: 14 }, "resource-1")).toEqual({ state: "conflict", correlationId: ids.correlation, currentVersion: 2, detail: "Resource changed" });
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
    for (const [workspace, operation, payload, target] of [
      ["processes", "create", { name: "September cohort" }],
      ["processes", "start", { processDefinition: "pilot-v1", processId: "process-1" }, "process-1"],
      ["interventions", "accept", { evidenceVersion: 3, expectedVersion: 4 }, "review-1"],
      ["interventions", "conditional", { evidenceVersion: 3, expectedVersion: 4, followUp: "Add signature", dueAt: "2026-08-05" }, "review-1"],
      ["interventions", "reject", { evidenceVersion: 3, expectedVersion: 4 }, "review-1"],
      ["risks", "acknowledge", { expectedVersion: 5 }, "risk-1"],
      ["risks", "mitigate", { expectedVersion: 5, mitigation: "Daily review" }, "risk-1"],
      ["risks", "resolve", { expectedVersion: 5, resolution: "Evidence accepted" }, "risk-1"],
    ] as const) {
      const receipt = await executeFixtureCommand(page, workspace, operation, payload, target);
      expect(receipt).toMatchObject({ state: "completed", correlationId: ids.correlation });
    }
    await page.getByRole("link", { name: "介入中心", exact: true }).click();
    await expect(page.getByText("Pilot handbook section 4.2")).toBeVisible();
    await page.getByRole("link", { name: "风险", exact: true }).click();
    await expect(page.getByText("Participant deadline at risk")).toBeVisible();
    await assertNoSeriousAxeViolations(page);
  } finally {
    await fixture.close();
  }
});
