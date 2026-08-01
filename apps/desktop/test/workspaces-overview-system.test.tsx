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
      environment="试点环境"
      onQueryChange={vi.fn()}
      onRefresh={vi.fn()}
    />);

    expect(screen.getByRole("heading", { level: 1, name: "运行总览" })).toBeInTheDocument();
    const metrics = screen.getByRole("region", { name: "运行指标" });
    for (const label of ["关注事项", "时限", "风险", "流程"]) {
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
          { item: "入职流程", type: "process", status: "active" },
        ],
        count: 4,
        fetchedAt,
      }}
      statuses={statuses}
      query={query}
      environment="试点环境"
      onQueryChange={onQueryChange}
      onRefresh={onRefresh}
    />);

    const metrics = screen.getByRole("region", { name: "运行指标" });
    expect(within(metrics).getAllByText("1")).toHaveLength(4);
    expect(screen.getByRole("table", { name: "工作区数据" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "供应" } });
    expect(onQueryChange).toHaveBeenCalledWith(expect.objectContaining({ search: "供应" }));
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});

describe("SystemOperations", () => {
  it("renders service and component versions, environment, and freshness read-only", () => {
    render(<SystemOperations
      definition={WORKSPACE_DEFINITIONS.system}
      result={{ state: "empty", fetchedAt }}
      statuses={statuses}
      query={{ ...query, sort: "service-asc" }}
      environment="试点环境"
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
      environment="开发环境"
      onQueryChange={vi.fn()}
      onRefresh={vi.fn()}
    />);
    expect(document.body).toHaveTextContent(expected);
  });
});
