import { fireEvent, render, screen, within } from "@testing-library/react";
import type { SystemStatus } from "@innorder/contracts";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceResult } from "../src/desktop-contract";
import type { WorkspaceQueryValue } from "../src/renderer/components/QueryToolbar";
import { Overview } from "../src/renderer/workspaces/Overview";
import { SystemOperations } from "../src/renderer/workspaces/SystemOperations";
import { WORKSPACE_DEFINITIONS } from "../src/renderer/workspaces/workspace-definitions";

const fetchedAt = "2026-08-01T12:00:00.000Z";
const query: WorkspaceQueryValue = { search: "", filters: {}, sort: "priority-desc" };
const statuses: SystemStatus[] = [{
  service: "occ-core",
  version: "1.7.0",
  state: "DEGRADED",
  checkedAt: fetchedAt,
  components: [{
    id: "postgresql",
    label: "PostgreSQL",
    state: "READY",
    detail: "连接可用",
    checkedAt: fetchedAt,
  }],
}];

const unavailable: WorkspaceResult = {
  state: "unavailable",
  reason: "UNAVAILABLE_CONTRACT",
  resourceGroups: ["/me", "/tasks", "/processes", "/risks"],
  message: "总览业务 API 合同尚未集成",
};

describe("Overview", () => {
  it("renders honest unavailable metrics and only validated service health", () => {
    render(<Overview
      definition={WORKSPACE_DEFINITIONS.overview}
      result={unavailable}
      statuses={[...statuses, { service: "raw-secret" } as unknown as SystemStatus]}
      query={query}
      activeTab="attention"
      environment="试点环境"
      onTabChange={vi.fn()}
      onQueryChange={vi.fn()}
      onRefresh={vi.fn()}
    />);

    expect(screen.getByRole("heading", { level: 1, name: "运行总览" })).toBeInTheDocument();
    const metrics = screen.getByRole("region", { name: "运行指标" });
    for (const label of ["关注事项", "时限", "风险", "进行中流程"]) {
      expect(within(metrics).getByRole("heading", { level: 2, name: label })).toBeInTheDocument();
    }
    expect(within(metrics).getAllByText("--")).toHaveLength(4);
    expect(within(metrics).getAllByText("不可用")).toHaveLength(4);

    const health = screen.getByRole("table", { name: "服务健康" });
    expect(within(health).getByRole("cell", { name: "occ-core" })).toBeInTheDocument();
    expect(within(health).getByRole("cell", { name: "降级" })).toBeInTheDocument();
    expect(within(health).getByRole("cell", { name: "1.7.0" })).toBeInTheDocument();
    expect(within(health).getByRole("cell", { name: "试点环境" })).toBeInTheDocument();
    expect(health).toHaveTextContent("2026");
    expect(document.body).not.toHaveTextContent("raw-secret");
    expect(screen.getByLabelText("工作区合同不可用")).toHaveTextContent("/me、/tasks、/processes、/risks");
  });

  it("counts only validated result rows and delegates query actions", () => {
    const onQueryChange = vi.fn();
    const onRefresh = vi.fn();
    render(<Overview
      definition={WORKSPACE_DEFINITIONS.overview}
      result={{
        state: "ready",
        items: [
          { item: "待审核证据", type: "attention", status: "open", dueAt: fetchedAt },
          { item: "今日截止", type: "deadline", status: "open", dueAt: fetchedAt },
          { item: "供应风险", type: "risk", status: "open", dueAt: fetchedAt },
          { item: "采购流程", type: "process", status: "RUNNING" },
          { item: "暂停流程", type: "process", status: "SUSPENDED" },
          { item: "完成流程", type: "process", status: "COMPLETED" },
          { item: "取消流程", type: "process", status: "CANCELLED" },
          { item: "失败流程", type: "process", status: "FAILED" },
        ],
        count: 8,
        fetchedAt,
      }}
      statuses={statuses}
      query={query}
      activeTab="attention"
      environment="试点环境"
      onTabChange={vi.fn()}
      onQueryChange={onQueryChange}
      onRefresh={onRefresh}
    />);

    const metrics = screen.getByRole("region", { name: "运行指标" });
    expect(within(metrics).getAllByText("1")).toHaveLength(4);
    expect(within(metrics).getByRole("heading", { level: 2, name: "进行中流程" }).parentElement).toHaveTextContent("1");
    expect(screen.getByRole("table", { name: "工作区数据" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "供应" } });
    expect(onQueryChange).toHaveBeenCalledWith(expect.objectContaining({ search: "供应" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("rejects invented process states from metrics and workspace data", () => {
    render(<Overview
      definition={WORKSPACE_DEFINITIONS.overview}
      result={{
        state: "ready",
        items: [{ item: "错误流程", type: "process", status: "ACTIVE" }],
        count: 1,
        fetchedAt,
      }}
      statuses={statuses}
      query={query}
      activeTab="attention"
      environment="试点环境"
      onTabChange={vi.fn()}
      onQueryChange={vi.fn()}
      onRefresh={vi.fn()}
    />);

    expect(within(screen.getByRole("region", { name: "运行指标" })).getAllByText("--")).toHaveLength(4);
    expect(screen.getByRole("region", { name: "数据校验错误" })).toHaveTextContent("数据格式无效");
    expect(document.body).not.toHaveTextContent("错误流程");
  });

  it("renders controlled tabs and supports roving keyboard focus", () => {
    const onTabChange = vi.fn();
    render(<Overview
      definition={WORKSPACE_DEFINITIONS.overview}
      result={unavailable}
      statuses={statuses}
      query={query}
      activeTab="attention"
      environment="试点环境"
      onTabChange={onTabChange}
      onQueryChange={vi.fn()}
      onRefresh={vi.fn()}
    />);

    const tabs = within(screen.getByRole("tablist", { name: "运行总览视图" })).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["关注事项", "时限", "风险", "服务健康"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveAttribute("tabindex", "0");
    expect(tabs[1]).toHaveAttribute("tabindex", "-1");
    expect(tabs[0]).toHaveAttribute("aria-controls", "overview-panel");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "overview-tab-attention");
    for (const tab of tabs) {
      expect(document.getElementById(tab.getAttribute("aria-controls")!)).toBeInTheDocument();
    }

    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(tabs[1]).toHaveFocus();
    expect(onTabChange).toHaveBeenLastCalledWith("deadlines");
    fireEvent.keyDown(tabs[1]!, { key: "End" });
    expect(tabs[3]).toHaveFocus();
    expect(onTabChange).toHaveBeenLastCalledWith("health");
    fireEvent.keyDown(tabs[3]!, { key: "Home" });
    expect(tabs[0]).toHaveFocus();
    expect(onTabChange).toHaveBeenLastCalledWith("attention");
    fireEvent.click(tabs[2]!);
    expect(onTabChange).toHaveBeenLastCalledWith("risks");
  });
});

describe("SystemOperations", () => {
  it("renders service and component versions, environment, and freshness read-only", () => {
    render(<SystemOperations
      definition={WORKSPACE_DEFINITIONS.system}
      result={{ state: "empty", fetchedAt }}
      statuses={statuses}
      query={{ ...query, sort: "service-asc" }}
      activeTab="services"
      environment="试点环境"
      onTabChange={vi.fn()}
      onQueryChange={vi.fn()}
      onRefresh={vi.fn()}
    />);

    expect(screen.getByRole("heading", { level: 1, name: "系统运行" })).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "服务与组件状态" });
    expect(within(table).getByRole("cell", { name: "occ-core" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "PostgreSQL" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "1.7.0" })).toBeInTheDocument();
    expect(within(table).getAllByRole("cell", { name: "试点环境" })).toHaveLength(2);
    expect(within(table).getAllByText(/2026/)).toHaveLength(2);

    expect(screen.getByRole("region", { name: "Outbox 状态" })).toHaveTextContent("不可用");
    expect(screen.getByRole("region", { name: "通知投递状态" })).toHaveTextContent("不可用");
    expect(document.body).not.toHaveTextContent(/restart|shell|backup|restore|container|重启|终端|备份|恢复|容器/i);
    for (const forbidden of ["重启", "Shell", "备份", "恢复", "容器"]) {
      expect(screen.queryByRole("button", { name: new RegExp(forbidden, "i") })).not.toBeInTheDocument();
    }
  });

  it("renders controlled tabs and wraps roving focus with arrow keys", () => {
    const onTabChange = vi.fn();
    render(<SystemOperations
      definition={WORKSPACE_DEFINITIONS.system}
      result={{ state: "empty", fetchedAt }}
      statuses={statuses}
      query={{ ...query, sort: "service-asc" }}
      activeTab="services"
      environment="试点环境"
      onTabChange={onTabChange}
      onQueryChange={vi.fn()}
      onRefresh={vi.fn()}
    />);

    const tabs = within(screen.getByRole("tablist", { name: "系统运行视图" })).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["服务", "依赖", "事件投递"]);
    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: "ArrowLeft" });
    expect(tabs[2]).toHaveFocus();
    expect(onTabChange).toHaveBeenCalledWith("delivery");
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "system-panel");
    for (const tab of tabs) {
      expect(document.getElementById(tab.getAttribute("aria-controls")!)).toBeInTheDocument();
    }
  });

  it("renders only validated ISO configuration freshness", () => {
    const props = {
      definition: WORKSPACE_DEFINITIONS.system,
      result: { state: "empty" as const, fetchedAt },
      statuses,
      query: { ...query, sort: "service-asc" },
      activeTab: "services",
      environment: "试点环境",
      onTabChange: vi.fn(),
      onQueryChange: vi.fn(),
      onRefresh: vi.fn(),
    };
    const { rerender } = render(<SystemOperations {...props} configurationFreshness="not-a-date" />);

    expect(within(screen.getByText("配置新鲜度").parentElement!).getByText("--")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("Invalid Date");

    rerender(<SystemOperations {...props} configurationFreshness={fetchedAt} />);
    expect(within(screen.getByText("配置新鲜度").parentElement!).getByRole("time")).toHaveAttribute("datetime", fetchedAt);
  });

  it.each([
    [{ state: "loading", label: "正在加载系统状态" } satisfies WorkspaceResult, "正在加载系统状态"],
    [{ state: "error", problem: { title: "系统状态查询失败", code: "SYSTEM_QUERY_FAILED", status: 503 } } satisfies WorkspaceResult, "SYSTEM_QUERY_FAILED"],
    [{ state: "stale", items: [{ service: "occ-core", version: "1.7.0", state: "DEGRADED", freshness: fetchedAt }], count: 1, fetchedAt } satisfies WorkspaceResult, "过期数据，只读"],
    [{ state: "offline", items: [{ service: "occ-core", version: "1.7.0", state: "DEGRADED", freshness: fetchedAt }], count: 1, fetchedAt } satisfies WorkspaceResult, "离线数据，只读"],
    [{ state: "conflict", currentVersion: 7 } satisfies WorkspaceResult, "当前版本 7"],
    [{ state: "unavailable", reason: "UNAVAILABLE_CONTRACT", resourceGroups: ["/system"], message: "系统 API 不可用" } satisfies WorkspaceResult, "系统 API 不可用"],
  ])("renders shared $state state", (result, expected) => {
    render(<SystemOperations
      definition={WORKSPACE_DEFINITIONS.system}
      result={result}
      statuses={[]}
      query={{ ...query, sort: "service-asc" }}
      activeTab="services"
      environment="开发环境"
      onTabChange={vi.fn()}
      onQueryChange={vi.fn()}
      onRefresh={vi.fn()}
    />);
    expect(document.body).toHaveTextContent(expected);
  });
});
