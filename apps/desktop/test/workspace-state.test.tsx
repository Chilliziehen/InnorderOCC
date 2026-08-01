import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import {
  commandReceiptSchema,
  workspaceCommandSchema,
  workspaceResultSchema,
  type WorkspaceCommand,
} from "../src/desktop-contract";
import { CommandPanel } from "../src/renderer/components/CommandPanel";
import { QueryToolbar, type WorkspaceQueryValue } from "../src/renderer/components/QueryToolbar";
import { WorkspaceState } from "../src/renderer/components/WorkspaceState";
import {
  WORKSPACE_DEFINITIONS,
  commandFor,
  type WorkspaceDefinition,
} from "../src/renderer/workspaces/workspace-definitions";

const itemSchema = z.object({ id: z.string(), name: z.string() }).strict();
const fetchedAt = "2026-08-01T12:00:00.000Z";
const correlationId = "00000000-0000-4000-8000-000000000099";

describe("workspace production definitions", () => {
  it("defines and deeply freezes the nine approved workspaces plus settings", () => {
    expect(Object.keys(WORKSPACE_DEFINITIONS)).toEqual([
      "overview", "my-work", "processes", "interventions", "risks", "resources",
      "domain-design", "administration", "system", "settings",
    ]);
    for (const definition of Object.values(WORKSPACE_DEFINITIONS)) {
      expect(definition.apiGroups.length).toBeGreaterThan(0);
      expect(definition.tabs.length).toBeGreaterThan(0);
      expect(definition.columns.length).toBeGreaterThan(0);
      expect(definition.query.operation).not.toBe("");
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.apiGroups)).toBe(true);
      expect(Object.isFrozen(definition.filters)).toBe(true);
      expect(Object.isFrozen(definition.query.availability)).toBe(true);
    }
  });

  it("keeps only committed system and profile/session operations available", () => {
    const available = Object.values(WORKSPACE_DEFINITIONS).flatMap((definition) => [
      [definition.id, definition.query.operation, definition.query.availability.state],
      ...definition.commands.map((command) => [definition.id, command.operation, command.availability.state]),
    ]);
    expect(available.filter(([, , state]) => state === "available")).toEqual([
      ["system", "system.status", "available"],
      ["settings", "profiles.current", "available"],
      ["settings", "profiles.select", "available"],
      ["settings", "profiles.save", "available"],
      ["settings", "profiles.remove", "available"],
      ["settings", "session.logout", "available"],
    ]);
    for (const [, , state] of available.filter(([id]) => !["system", "settings"].includes(id!))) {
      expect(state).toBe("unavailable");
    }
  });

  it("records the exact plan resource groups and defaults forged operations to deny", () => {
    expect(WORKSPACE_DEFINITIONS["my-work"].apiGroups).toEqual([
      "/tasks", "/evidence", "/reservations", "/recommendations",
    ]);
    expect(WORKSPACE_DEFINITIONS.administration.apiGroups).toEqual([
      "/people", "/relationships", "/roles", "/policy-releases", "/providers", "/knowledge", "/audit",
    ]);
    expect(commandFor("risks", "resolve")?.capability).toBe("risks.resolve");
    expect(commandFor("risks", "forged-operation")).toBeUndefined();

    const forged = Object.create(WORKSPACE_DEFINITIONS.risks) as WorkspaceDefinition;
    Object.defineProperty(forged, "commands", { value: [{ operation: "forged-operation" }] });
    expect(commandFor(forged, "forged-operation")).toBeUndefined();
  });

  it("locks the exact UI metadata matrix for every workspace", () => {
    const matrix = Object.fromEntries(Object.entries(WORKSPACE_DEFINITIONS).map(([id, definition]) => [id, {
      tabs: definition.tabs.map((tab) => tab.id),
      filters: definition.filters.map((filter) => filter.key),
      sorts: definition.sortOptions.map((sort) => sort.value),
      columns: definition.columns.map((column) => column.key),
    }]));
    expect(matrix).toEqual({
      overview: { tabs: ["attention", "deadlines", "risks", "health"], filters: ["severity"], sorts: ["priority-desc", "due-asc"], columns: ["item", "type", "status", "dueAt"] },
      "my-work": { tabs: ["available", "claimed", "blocked", "pending-review", "returned", "completed"], filters: ["state"], sorts: ["due-asc", "updated-desc"], columns: ["task", "process", "state", "dueAt"] },
      processes: { tabs: ["cohorts", "processes", "participants", "tasks", "timeline"], filters: ["status", "participant", "timeline"], sorts: ["updated-desc", "started-desc"], columns: ["process", "cohort", "owner", "status"] },
      interventions: { tabs: ["reviews", "exceptions", "policy", "ai"], filters: ["type", "status"], sorts: ["created-desc", "priority-desc"], columns: ["item", "type", "owner", "status"] },
      risks: { tabs: ["open", "mine", "resolved"], filters: ["severity", "sla", "owner", "status"], sorts: ["severity-desc", "updated-desc", "sla-asc"], columns: ["risk", "severity", "owner", "status"] },
      resources: { tabs: ["inventory", "reservations", "conflicts"], filters: ["type", "availability", "conflict"], sorts: ["name-asc", "availability-desc"], columns: ["resource", "type", "availability", "reservation"] },
      "domain-design": { tabs: ["drafts", "versions", "validation", "releases"], filters: ["status", "validation"], sorts: ["updated-desc", "name-asc"], columns: ["package", "version", "validation", "status"] },
      administration: { tabs: ["people", "relationships", "roles", "policies", "providers", "knowledge", "audit"], filters: ["status", "type"], sorts: ["updated-desc", "name-asc"], columns: ["subject", "type", "status", "updatedAt"] },
      system: { tabs: ["services", "dependencies", "delivery"], filters: ["state"], sorts: ["service-asc", "state-asc"], columns: ["service", "version", "state", "freshness"] },
      settings: { tabs: ["profile", "trust", "preferences", "session"], filters: [], sorts: ["name-asc"], columns: ["profile", "environment", "origin", "trust"] },
    });
  });

  it("recursively freezes every metadata branch", () => {
    const assertDeepFrozen = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      expect(Object.isFrozen(value)).toBe(true);
      for (const child of Object.values(value)) assertDeepFrozen(child);
    };
    assertDeepFrozen(WORKSPACE_DEFINITIONS);
  });

  it("defines labels for every UI-owned metadata descriptor", () => {
    for (const definition of Object.values(WORKSPACE_DEFINITIONS)) {
      const descriptors = [
        ...definition.tabs,
        ...definition.filters,
        ...definition.filters.flatMap(({ options }) => options),
        ...definition.sortOptions,
        ...definition.columns,
      ];
      expect(descriptors.every(({ label }) => label.length > 0)).toBe(true);
    }
  });
});

describe("canonical workspace contracts", () => {
  it.each([
    { state: "loading", label: "Loading risks" },
    { state: "ready", items: [{ id: "r-1" }], count: 1, nextCursor: "next", fetchedAt },
    { state: "empty", fetchedAt },
    { state: "error", problem: { title: "Query failed", code: "QUERY_FAILED", status: 503, correlationId } },
    { state: "stale", items: [{ id: "r-1" }], count: 1, fetchedAt },
    { state: "offline", items: [{ id: "r-1" }], count: 1, fetchedAt },
    { state: "conflict", currentVersion: 17, correlationId },
    { state: "unavailable", reason: "UNAVAILABLE_CONTRACT", resourceGroups: ["/risks"], message: "风险 API 合同尚未集成" },
  ])("validates the $state workspace result discriminant", (result) => {
    expect(workspaceResultSchema.parse(result)).toEqual(result);
  });

  it("requires a validated currentVersion on conflict command receipts", () => {
    const receipt = { state: "conflict", currentVersion: 9, correlationId };
    expect(commandReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(() => commandReceiptSchema.parse({ state: "conflict", correlationId })).toThrow();
    expect(() => commandReceiptSchema.parse({ ...receipt, currentVersion: "9" })).toThrow();
    expect(() => commandReceiptSchema.parse({ ...receipt, currentVersion: -1 })).toThrow();
  });

  it("validates exact unavailable command integration messages", () => {
    const receipt = { state: "unavailable", reason: "UNAVAILABLE_CONTRACT", resourceGroups: ["/risks"], message: "风险命令 API 合同尚未集成" };
    expect(commandReceiptSchema.parse(receipt)).toEqual(receipt);
  });

  it("accepts an intent handle and rejects renderer-generated idempotency keys", () => {
    const command = { workspace: "risks", operation: "resolve", payload: {}, intentHandle: correlationId };
    expect(workspaceCommandSchema.parse(command)).toEqual(command);
    expect(() => workspaceCommandSchema.parse({ ...command, idempotencyKey: correlationId })).toThrow();
  });
});

describe("WorkspaceState", () => {
  it("renders loading as a labelled progress region", () => {
    render(<WorkspaceState result={{ state: "loading", label: "正在加载风险" }} itemSchema={itemSchema} />);
    expect(screen.getByRole("region", { name: "正在加载风险" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("renders validated data with count, cursor, and freshness without fake records", () => {
    render(<WorkspaceState
      result={{ state: "ready", items: [{ id: "r-1", name: "供应风险" }], count: 1, nextCursor: "next", fetchedAt }}
      itemSchema={itemSchema}
      columns={[{ key: "name", label: "名称" }]}
    />);
    expect(screen.getByText("供应风险")).toBeInTheDocument();
    expect(screen.getByText("1 项")).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
    expect(screen.getByText(/下一页可用/)).toBeInTheDocument();
  });

  it("fails safely when ready records do not match the item contract", () => {
    render(<WorkspaceState
      result={{ state: "ready", items: [{ id: "r-1", secret: "raw-token" }], count: 1, fetchedAt }}
      itemSchema={itemSchema}
    />);
    expect(screen.getByRole("region", { name: "数据校验错误" })).toHaveTextContent("数据格式无效");
    expect(document.body).not.toHaveTextContent("raw-token");
  });

  it("renders empty with only a permitted next command", () => {
    const onCommand = vi.fn();
    const { rerender } = render(<WorkspaceState
      result={{ state: "empty", fetchedAt, nextCommand: { label: "创建流程", permitted: false } }}
      itemSchema={itemSchema}
      onNextCommand={onCommand}
    />);
    expect(screen.queryByRole("button", { name: "创建流程" })).not.toBeInTheDocument();
    rerender(<WorkspaceState
      result={{ state: "empty", fetchedAt, nextCommand: { label: "创建流程", permitted: true } }}
      itemSchema={itemSchema}
      onNextCommand={onCommand}
    />);
    fireEvent.click(screen.getByRole("button", { name: "创建流程" }));
    expect(onCommand).toHaveBeenCalledOnce();
  });

  it("renders a safe ProblemReceipt and retry without raw detail", () => {
    const onRetry = vi.fn();
    render(<WorkspaceState
      result={{ state: "error", problem: { title: "查询失败", detail: "token raw-secret", code: "QUERY_FAILED", status: 503, correlationId } }}
      itemSchema={itemSchema}
      onRetry={onRetry}
    />);
    const alert = screen.getByRole("region", { name: "查询错误" });
    expect(alert).toHaveTextContent("QUERY_FAILED");
    expect(alert).toHaveTextContent("503");
    expect(alert).toHaveTextContent(correlationId);
    expect(alert).not.toHaveTextContent(/raw-secret|token/);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it.each(["stale", "offline"] as const)("renders %s data age read-only outside the live region", (state) => {
    render(<WorkspaceState
      result={{ state, items: [{ id: "r-1", name: "已缓存风险" }], count: 1, fetchedAt }}
      itemSchema={itemSchema}
      now={new Date("2026-08-01T12:02:00.000Z").getTime()}
    />);
    expect(screen.getByText("已缓存风险")).toBeInTheDocument();
    expect(screen.getByText(/2 分钟/)).not.toHaveAttribute("aria-live");
    expect(screen.getAllByText(/只读/).length).toBeGreaterThan(0);
    expect(screen.getByTestId("workspace-state-announcement")).not.toHaveTextContent(/2 分钟/);
  });

  it("renders conflict version and refresh action", () => {
    const onRefresh = vi.fn();
    render(<WorkspaceState result={{ state: "conflict", currentVersion: 17, correlationId }} itemSchema={itemSchema} onRefresh={onRefresh} />);
    expect(screen.getByRole("region", { name: "版本冲突" })).toHaveTextContent(/17/);
    fireEvent.click(screen.getByRole("button", { name: "刷新当前版本" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("renders exact unavailable APIs and disabled controls", () => {
    render(<WorkspaceState
      result={{ state: "unavailable", reason: "UNAVAILABLE_CONTRACT", resourceGroups: ["/tasks", "/evidence"], message: "任务与证据 API 合同尚未集成" }}
      itemSchema={itemSchema}
      unavailableControls={["领取任务", "提交证据"]}
    />);
    expect(screen.getByLabelText("工作区合同不可用")).toHaveTextContent("UNAVAILABLE_CONTRACT");
    expect(screen.getByLabelText("工作区合同不可用")).toHaveTextContent("/tasks、/evidence");
    expect(screen.getByRole("button", { name: "领取任务" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "提交证据" })).toBeDisabled();
    expect(document.body).not.toHaveTextContent(/示例|sample/i);
  });

  it("uses one atomic live region and changes repeated transition announcements", async () => {
    const first = { state: "empty" as const, fetchedAt };
    const { rerender } = render(<WorkspaceState result={first} itemSchema={itemSchema} />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    const initial = screen.getByRole("status").textContent;
    rerender(<WorkspaceState result={{ ...first }} itemSchema={itemSchema} />);
    await waitFor(() => expect(screen.getByRole("status").textContent).not.toBe(initial));
    expect(screen.getByRole("status")).toHaveAttribute("aria-atomic", "true");
  });

  it.each([
    { state: "error" as const, problem: { title: "查询失败", code: "QUERY_FAILED", status: 503 } },
    { state: "conflict" as const, currentVersion: 17 },
  ])("keeps $state visual content out of a second live region", (result) => {
    render(<WorkspaceState result={result} itemSchema={itemSchema} />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("announces each explicit conflict refresh before invoking it", () => {
    const onRefresh = vi.fn();
    render(<WorkspaceState result={{ state: "conflict", currentVersion: 17 }} itemSchema={itemSchema} onRefresh={onRefresh} />);
    const before = screen.getByRole("status").textContent;
    fireEvent.click(screen.getByRole("button", { name: "刷新当前版本" }));
    expect(screen.getByRole("status").textContent).not.toBe(before);
    expect(screen.getByRole("status")).toHaveTextContent("正在刷新当前版本");
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});

describe("QueryToolbar", () => {
  const definition = WORKSPACE_DEFINITIONS.risks;
  const initial: WorkspaceQueryValue = { search: "", filters: {}, sort: "severity-desc" };

  it("updates controlled search, filters, sort, clear, and refresh", async () => {
    const onChange = vi.fn();
    const onRefresh = vi.fn();
    render(<QueryToolbar definition={definition} value={initial} onChange={onChange} onRefresh={onRefresh} />);
    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "逾期" } });
    fireEvent.change(screen.getByLabelText("严重性"), { target: { value: "high" } });
    fireEvent.change(screen.getByLabelText("排序"), { target: { value: "updated-desc" } });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ search: "逾期" })));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ filters: { severity: "high" } }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ sort: "updated-desc" }));
    fireEvent.click(screen.getByRole("button", { name: "清除查询条件" }));
    expect(onChange).toHaveBeenCalledWith({ search: "", filters: {}, sort: "severity-desc" });
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("moves through cursors only when previous and next are present", () => {
    const onChange = vi.fn();
    const { rerender } = render(<QueryToolbar definition={definition} value={initial} onChange={onChange} onRefresh={vi.fn()} />);
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
    rerender(<QueryToolbar definition={definition} value={{ ...initial, cursor: "current", previousCursor: "previous", nextCursor: "next" }} onChange={onChange} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    expect(onChange).toHaveBeenCalledWith({ ...initial, cursor: "previous" });
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(onChange).toHaveBeenCalledWith({ ...initial, cursor: "next" });
  });

  it("clears all cursor fields and preserves cumulative rapid query changes", () => {
    const onChange = vi.fn();
    render(<QueryToolbar
      definition={definition}
      value={{ ...initial, cursor: "current", previousCursor: "previous", nextCursor: "next" }}
      onChange={onChange}
      onRefresh={vi.fn()}
    />);
    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "逾期" } });
    fireEvent.change(screen.getByLabelText("严重性"), { target: { value: "high" } });
    fireEvent.change(screen.getByLabelText("排序"), { target: { value: "updated-desc" } });
    expect(onChange).toHaveBeenLastCalledWith({
      search: "逾期",
      filters: { severity: "high" },
      sort: "updated-desc",
    });
  });
});

describe("CommandPanel", () => {
  const command = WORKSPACE_DEFINITIONS.settings.commands.find(({ operation }) => operation === "profiles.save")!;
  const unavailableCommand = WORKSPACE_DEFINITIONS.risks.commands.find(({ operation }) => operation === "resolve")!;

  it.each([
    { name: "offline lock", props: { online: false, authenticated: true, capabilities: [command.capability] }, reason: "离线时更改操作已锁定" },
    { name: "signed out", props: { online: true, authenticated: false, capabilities: [command.capability] }, reason: "需要有效登录会话" },
    { name: "capability absent", props: { online: true, authenticated: true, capabilities: [] }, reason: `缺少能力：${command.capability}` },
  ])("blocks $name in the handler and visibly associates the reason", ({ props, reason }) => {
    const onExecute = vi.fn();
    const { container } = render(<CommandPanel workspace="settings" command={command} payload={{}} onExecute={onExecute} {...props} />);
    const button = screen.getByRole("button", { name: command.label });
    expect(button).toBeDisabled();
    const reasonNode = screen.getByText(reason);
    expect(button).toHaveAttribute("aria-describedby", reasonNode.id);
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    expect(onExecute).not.toHaveBeenCalled();
  });

  it("explains unavailable operations and rejects forced submission", () => {
    const onExecute = vi.fn();
    const { container } = render(<CommandPanel workspace="risks" command={unavailableCommand} capabilities={[unavailableCommand.capability]} online authenticated payload={{}} onExecute={onExecute} />);
    expect(unavailableCommand.availability.state).toBe("unavailable");
    if (unavailableCommand.availability.state !== "unavailable") throw new Error("test requires unavailable command");
    expect(screen.getByText(unavailableCommand.availability.message)).toBeInTheDocument();
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    expect(onExecute).not.toHaveBeenCalled();
  });

  it("default-denies a forged command descriptor", () => {
    const onExecute = vi.fn();
    const forged = { ...command, operation: "forged-operation" };
    const { container } = render(<CommandPanel workspace="settings" command={forged} capabilities={[forged.capability]} online authenticated payload={{}} onExecute={onExecute} />);
    expect(screen.getByText("未注册的操作")).toBeInTheDocument();
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    expect(onExecute).not.toHaveBeenCalled();
  });

  it("cannot forge availability for a registered unavailable operation", () => {
    const onExecute = vi.fn();
    const forged = { ...unavailableCommand, availability: { state: "available" as const } };
    const { container } = render(<CommandPanel workspace="risks" command={forged} capabilities={[forged.capability]} online authenticated payload={{}} onExecute={onExecute} />);
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    expect(onExecute).not.toHaveBeenCalled();
    expect(screen.getByText(/风险解决 API 合同尚未集成/)).toBeInTheDocument();
  });

  it("coalesces double submission under one intent handle and renders a safe receipt", async () => {
    let resolve!: (value: { state: "completed"; commandId: string; correlationId: string }) => void;
    let intent: WorkspaceCommand | undefined;
    const onExecute = vi.fn((submitted: WorkspaceCommand) => {
      intent = submitted;
      return new Promise<{ state: "completed"; commandId: string; correlationId: string }>((done) => void (resolve = done));
    });
    const { container } = render(<CommandPanel workspace="settings" command={command} capabilities={[command.capability]} online authenticated payload={{ version: 2 }} onExecute={onExecute} />);
    const form = container.querySelector("form") as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(onExecute).toHaveBeenCalledOnce();
    expect(intent).toBeDefined();
    if (!intent) throw new Error("intent was not submitted");
    expect(intent.intentHandle).toMatch(/^[0-9a-f-]{36}$/i);
    expect(intent).not.toHaveProperty("idempotencyKey");
    expect(intent).toMatchObject({ workspace: "settings", operation: "profiles.save", payload: { version: 2 } });
    resolve({ state: "completed", commandId: "00000000-0000-4000-8000-000000000088", correlationId });
    expect(await screen.findByRole("status", { name: "命令回执" })).toHaveTextContent(correlationId);
  });

  it("reuses the same handle for an exact-payload transport retry", async () => {
    const onExecute = vi.fn()
      .mockRejectedValueOnce(new Error("token transport-secret"))
      .mockResolvedValueOnce({ state: "completed", commandId: "00000000-0000-4000-8000-000000000088", correlationId });
    const { rerender } = render(<CommandPanel workspace="settings" command={command} capabilities={[command.capability]} online authenticated payload={{ version: 2, note: "same" }} onExecute={onExecute} />);
    fireEvent.click(screen.getByRole("button", { name: command.label }));
    expect(await screen.findByRole("status", { name: "命令回执" })).toHaveTextContent("命令提交失败");
    expect(document.body).not.toHaveTextContent(/transport-secret|token/);
    rerender(<CommandPanel workspace="settings" command={command} capabilities={[command.capability]} online authenticated payload={{ note: "same", version: 2 }} onExecute={onExecute} />);
    fireEvent.click(screen.getByRole("button", { name: command.label }));
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(2));
    expect(onExecute.mock.calls[1]![0].intentHandle).toBe(onExecute.mock.calls[0]![0].intentHandle);
  });

  it("reuses the same handle after a retryable timeout receipt", async () => {
    const onExecute = vi.fn()
      .mockResolvedValueOnce({ state: "problem", problem: { title: "Timed out", code: "TIMEOUT", status: 504, retryable: true } })
      .mockResolvedValueOnce({ state: "completed", commandId: "00000000-0000-4000-8000-000000000088", correlationId });
    render(<CommandPanel workspace="settings" command={command} capabilities={[command.capability]} online authenticated payload={{ version: 2 }} onExecute={onExecute} />);
    fireEvent.click(screen.getByRole("button", { name: command.label }));
    await screen.findByText("TIMEOUT");
    fireEvent.click(screen.getByRole("button", { name: command.label }));
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(2));
    expect(onExecute.mock.calls[1]![0].intentHandle).toBe(onExecute.mock.calls[0]![0].intentHandle);
  });

  it("starts a new accepted intent when its payload is edited", async () => {
    const onExecute = vi.fn().mockResolvedValue({ state: "accepted", commandId: "00000000-0000-4000-8000-000000000088", correlationId });
    const { rerender } = render(<CommandPanel workspace="settings" command={command} capabilities={[command.capability]} online authenticated payload={{ version: 1 }} onExecute={onExecute} />);
    fireEvent.click(screen.getByRole("button", { name: command.label }));
    await screen.findByRole("status", { name: "命令回执" });
    const firstHandle = onExecute.mock.calls[0]![0].intentHandle;
    rerender(<CommandPanel workspace="settings" command={command} capabilities={[command.capability]} online authenticated payload={{ version: 2 }} onExecute={onExecute} />);
    fireEvent.click(screen.getByRole("button", { name: command.label }));
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(2));
    expect(onExecute.mock.calls[1]![0].intentHandle).not.toBe(firstHandle);
  });

  it("locks an accepted intent without exposing a manual reset", async () => {
    const onExecute = vi.fn().mockResolvedValue({ state: "accepted", commandId: "00000000-0000-4000-8000-000000000088", correlationId });
    const { container } = render(<CommandPanel workspace="settings" command={command} capabilities={[command.capability]} online authenticated payload={{ version: 2 }} onExecute={onExecute} />);
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    await screen.findByRole("status", { name: "命令回执" });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    expect(onExecute).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: command.label })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "重置命令意图" })).not.toBeInTheDocument();
  });

  it("starts a new handle after payload edits and terminal receipts", async () => {
    const onExecute = vi.fn().mockResolvedValue({ state: "completed", commandId: "00000000-0000-4000-8000-000000000088", correlationId });
    const { rerender } = render(<CommandPanel workspace="settings" command={command} capabilities={[command.capability]} online authenticated payload={{ version: 1 }} onExecute={onExecute} />);
    fireEvent.click(screen.getByRole("button", { name: command.label }));
    await waitFor(() => expect(onExecute).toHaveBeenCalledOnce());
    const firstHandle = onExecute.mock.calls[0]![0].intentHandle;
    rerender(<CommandPanel workspace="settings" command={command} capabilities={[command.capability]} online authenticated payload={{ version: 2 }} onExecute={onExecute} />);
    fireEvent.click(screen.getByRole("button", { name: command.label }));
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(2));
    expect(onExecute.mock.calls[1]![0].intentHandle).not.toBe(firstHandle);
  });

  it("shows conflict version and refreshes through the callback without raw detail", async () => {
    const onConflictRefresh = vi.fn();
    const onExecute = vi.fn().mockResolvedValue({ state: "conflict", currentVersion: 9, correlationId, detail: "token raw-secret" });
    render(<CommandPanel workspace="settings" command={command} capabilities={[command.capability]} online authenticated payload={{}} onExecute={onExecute} onConflictRefresh={onConflictRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: command.label }));
    const receipt = await screen.findByRole("status", { name: "命令回执" });
    expect(receipt).toHaveTextContent(/9/);
    expect(receipt).toHaveTextContent(correlationId);
    expect(receipt).not.toHaveTextContent(/raw-secret|token/);
    fireEvent.click(within(receipt).getByRole("button", { name: "刷新当前版本" }));
    expect(onConflictRefresh).toHaveBeenCalledOnce();
  });

  it("renders dynamic unavailable receipt reason, groups, and message", async () => {
    const onExecute = vi.fn().mockResolvedValue({
      state: "unavailable",
      reason: "UNAVAILABLE_CONTRACT",
      resourceGroups: ["/profiles", "/audit"],
      message: "Profile audit command contract is unavailable",
    });
    render(<CommandPanel workspace="settings" command={command} capabilities={[command.capability]} online authenticated payload={{}} onExecute={onExecute} />);
    fireEvent.click(screen.getByRole("button", { name: command.label }));
    const receipt = await screen.findByRole("status", { name: "命令回执" });
    expect(receipt).toHaveTextContent("UNAVAILABLE_CONTRACT");
    expect(receipt).toHaveTextContent("/profiles、/audit");
    expect(receipt).toHaveTextContent("Profile audit command contract is unavailable");
  });

  it.each(["bigint", "cycle"] as const)("cleanly blocks %s command payloads", (kind) => {
    const onExecute = vi.fn();
    const payload: Record<string, unknown> = kind === "bigint" ? { value: 1n } : {};
    if (kind === "cycle") payload.self = payload;
    const { container } = render(<CommandPanel workspace="settings" command={command} capabilities={[command.capability]} online authenticated payload={payload} onExecute={onExecute} />);
    expect(screen.getByText("命令数据必须是严格 JSON")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: command.label })).toBeDisabled();
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    expect(onExecute).not.toHaveBeenCalled();
  });
});
