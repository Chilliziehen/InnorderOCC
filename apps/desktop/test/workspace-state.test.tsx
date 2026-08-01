import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceCommand } from "../src/desktop-contract";
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
});

describe("WorkspaceState", () => {
  it("renders loading as a labelled progress region", () => {
    render(<WorkspaceState result={{ state: "loading", label: "正在加载风险" }} itemSchema={itemSchema} />);
    expect(screen.getByRole("status", { name: "正在加载风险" })).toHaveAttribute("aria-busy", "true");
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
    expect(screen.getByRole("alert")).toHaveTextContent("数据格式无效");
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
      result={{ state: "problem", problem: { title: "查询失败", detail: "token raw-secret", code: "QUERY_FAILED", status: 503, correlationId } }}
      itemSchema={itemSchema}
      onRetry={onRetry}
    />);
    const alert = screen.getByRole("alert");
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
    render(<WorkspaceState result={{ state: "conflict", currentVersion: "v17", correlationId }} itemSchema={itemSchema} onRefresh={onRefresh} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/v17/);
    fireEvent.click(screen.getByRole("button", { name: "刷新当前版本" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("renders exact unavailable APIs and disabled controls", () => {
    render(<WorkspaceState
      result={{ state: "unavailable", reason: "UNAVAILABLE_CONTRACT", resourceGroups: ["/tasks", "/evidence"], message: "任务与证据 API 合同尚未集成" }}
      itemSchema={itemSchema}
      unavailableControls={["领取任务", "提交证据"]}
    />);
    expect(screen.getByRole("status")).toHaveTextContent("UNAVAILABLE_CONTRACT");
    expect(screen.getByRole("status")).toHaveTextContent("/tasks、/evidence");
    expect(screen.getByRole("button", { name: "领取任务" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "提交证据" })).toBeDisabled();
    expect(document.body).not.toHaveTextContent(/示例|sample/i);
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
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ cursor: "previous" }));
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ cursor: "next" }));
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

  it("coalesces double submission under one idempotent intent and renders a safe receipt", async () => {
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
    expect(intent.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(intent).toMatchObject({ workspace: "settings", operation: "profiles.save", payload: { version: 2 } });
    resolve({ state: "completed", commandId: "00000000-0000-4000-8000-000000000088", correlationId });
    expect(await screen.findByRole("status", { name: "命令回执" })).toHaveTextContent(correlationId);
  });

  it("shows conflict version and refreshes through the callback without raw detail", async () => {
    const onConflictRefresh = vi.fn();
    const onExecute = vi.fn().mockResolvedValue({ state: "conflict", currentVersion: "v9", correlationId, detail: "token raw-secret" });
    render(<CommandPanel workspace="settings" command={command} capabilities={[command.capability]} online authenticated payload={{}} onExecute={onExecute} onConflictRefresh={onConflictRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: command.label }));
    const receipt = await screen.findByRole("status", { name: "命令回执" });
    expect(receipt).toHaveTextContent(/v9/);
    expect(receipt).toHaveTextContent(correlationId);
    expect(receipt).not.toHaveTextContent(/raw-secret|token/);
    fireEvent.click(within(receipt).getByRole("button", { name: "刷新当前版本" }));
    expect(onConflictRefresh).toHaveBeenCalledOnce();
  });
});
