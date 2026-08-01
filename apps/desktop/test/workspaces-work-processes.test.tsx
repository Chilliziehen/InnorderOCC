import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CommandReceipt, WorkspaceCommand } from "../src/desktop-contract";
import { MyWork, type MyWorkProps } from "../src/renderer/workspaces/MyWork";
import { Processes, type ProcessesProps } from "../src/renderer/workspaces/Processes";
import { WORKSPACE_DEFINITIONS } from "../src/renderer/workspaces/workspace-definitions";

const fetchedAt = "2026-08-01T12:00:00.000Z";
const execute = vi.fn(async (_command: WorkspaceCommand): Promise<CommandReceipt> => ({
  state: "completed",
  commandId: "00000000-0000-4000-8000-000000000088",
  correlationId: "00000000-0000-4000-8000-000000000099",
}));

function myWorkProps(overrides: Partial<MyWorkProps> = {}): MyWorkProps {
  return {
    result: {
      state: "unavailable",
      reason: "UNAVAILABLE_CONTRACT",
      resourceGroups: ["/tasks"],
      message: "任务 API 合同尚未集成",
    },
    activeTab: "available",
    query: { search: "", filters: {}, sort: "due-asc" },
    capabilities: [],
    online: true,
    authenticated: true,
    onTabChange: vi.fn(),
    onQueryChange: vi.fn(),
    onRefresh: vi.fn(),
    onExecute: execute,
    onStartUpload: vi.fn(),
    onRetryUpload: vi.fn(),
    onCancelUpload: vi.fn(),
    ...overrides,
  };
}

function processProps(overrides: Partial<ProcessesProps> = {}): ProcessesProps {
  return {
    result: {
      state: "unavailable",
      reason: "UNAVAILABLE_CONTRACT",
      resourceGroups: ["/cohorts", "/processes", "/tasks"],
      message: "流程 API 合同尚未集成",
    },
    activeTab: "cohorts",
    query: { search: "", filters: {}, sort: "updated-desc" },
    capabilities: [],
    online: true,
    authenticated: true,
    onTabChange: vi.fn(),
    onQueryChange: vi.fn(),
    onRefresh: vi.fn(),
    onExecute: execute,
    ...overrides,
  };
}

describe("My Work workspace", () => {
  it("renders every canonical state tab and reports controlled tab changes", () => {
    const onTabChange = vi.fn();
    render(<MyWork {...myWorkProps({ onTabChange })} />);

    const tabs = screen.getByRole("tablist", { name: "工作状态" });
    for (const tab of WORKSPACE_DEFINITIONS["my-work"].tabs) {
      const control = within(tabs).getByRole("tab", { name: tab.label });
      expect(control).toHaveAttribute("aria-selected", String(tab.id === "available"));
      fireEvent.click(control);
      expect(onTabChange).toHaveBeenLastCalledWith(tab.id);
    }
  });

  it("uses shared search, state filter, sorting, and refresh callbacks", () => {
    const onQueryChange = vi.fn();
    const onRefresh = vi.fn();
    render(<MyWork {...myWorkProps({ onQueryChange, onRefresh })} />);

    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "校准" } });
    fireEvent.change(screen.getByLabelText("状态"), { target: { value: "claimed" } });
    fireEvent.change(screen.getByLabelText("排序"), { target: { value: "updated-desc" } });
    expect(onQueryChange).toHaveBeenLastCalledWith({
      search: "校准",
      filters: { state: "claimed" },
      sort: "updated-desc",
    });
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("renders validated work columns and task entry information without synthetic rows", () => {
    render(<MyWork {...myWorkProps({
      result: {
        state: "ready",
        items: [{ id: "task-17", task: "校准电源", process: "电子模块", state: "CLAIMED", dueAt: "2026-08-03T08:00:00Z" }],
        count: 1,
        fetchedAt,
      },
      selectedTask: {
        id: "task-17",
        evidenceRequirements: ["校准记录 PDF"],
        reservation: "电子实验台，08:00-10:00",
        reviewHistory: [{ id: "review-1", outcome: "RETURNED", occurredAt: "2026-08-01T09:00:00Z", note: "缺少仪器编号" }],
      },
    })} />);

    const table = screen.getByRole("table", { name: "工作区数据" });
    for (const column of WORKSPACE_DEFINITIONS["my-work"].columns) {
      expect(within(table).getByRole("columnheader", { name: column.label })).toBeInTheDocument();
    }
    expect(screen.getByText("校准电源")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "证据提交" })).toHaveTextContent("校准记录 PDF");
    expect(screen.getByRole("region", { name: "资源预留" })).toHaveTextContent("电子实验台");
    expect(screen.getByRole("region", { name: "审核历史" })).toHaveTextContent("缺少仪器编号");
    expect(document.body).not.toHaveTextContent(/示例|sample|demo/i);
  });

  it("shows upload progress, retry, quarantine, and review lifecycle states", () => {
    const onRetryUpload = vi.fn();
    const { rerender } = render(<MyWork {...myWorkProps({
      upload: { state: "uploading", fileName: "record.pdf", progress: 42, uploadId: "upload-17" },
      onRetryUpload,
    })} />);
    expect(screen.getByRole("progressbar", { name: "record.pdf 上传进度" })).toHaveAttribute("value", "42");

    rerender(<MyWork {...myWorkProps({
      upload: { state: "failed", fileName: "record.pdf", message: "上传未完成", retryable: true },
      onRetryUpload,
    })} />);
    const retry = screen.getByRole("button", { name: "重试上传" });
    expect(retry).toBeDisabled();
    fireEvent.click(retry);
    expect(onRetryUpload).not.toHaveBeenCalled();

    rerender(<MyWork {...myWorkProps({ upload: { state: "quarantined", fileName: "record.pdf", message: "正在进行安全扫描" } })} />);
    expect(screen.getByRole("status", { name: "证据隔离状态" })).toHaveTextContent("正在进行安全扫描");
  });

  it.each([
    { state: "disabled" as const, text: "智能建议已禁用" },
    { state: "stale" as const, text: "智能建议已过期" },
    { state: "unavailable" as const, text: "智能建议不可用" },
  ])("reports AI $state honestly and never presents it as authoritative", ({ state, text }) => {
    render(<MyWork {...myWorkProps({ guidance: { state, message: text } })} />);
    const guidance = screen.getByRole("region", { name: "智能建议" });
    expect(guidance).toHaveTextContent(text);
    expect(guidance).toHaveTextContent("仅供参考");
    expect(guidance).not.toHaveTextContent(/已批准|必须执行/);
  });

  it("shows exact unavailable contracts and locks every task mutation without callbacks", () => {
    const onStartUpload = vi.fn();
    const onCancelUpload = vi.fn();
    const onRetryUpload = vi.fn();
    execute.mockClear();
    const { container } = render(<MyWork {...myWorkProps({
      capabilities: ["tasks.claim", "evidence.submit", "reservations.create", "recommendations.request"],
      selectedTask: { id: "task-17", evidenceRequirements: [], reviewHistory: [] },
      upload: { state: "uploading", fileName: "record.pdf", progress: 42, uploadId: "upload-17" },
      onStartUpload,
      onCancelUpload,
      onRetryUpload,
    })} />);

    expect(screen.getByLabelText("工作区合同不可用")).toHaveTextContent("/tasks");
    for (const command of WORKSPACE_DEFINITIONS["my-work"].commands) {
      const button = screen.getByRole("button", { name: command.label });
      expect(button).toBeDisabled();
      if (command.availability.state !== "unavailable") throw new Error("test requires unavailable metadata");
      expect(document.body).toHaveTextContent(command.availability.message);
    }
    expect(screen.getByLabelText("选择证据文件")).toBeDisabled();
    expect(screen.getByRole("button", { name: "开始上传" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消上传" })).toBeDisabled();
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    expect(execute).not.toHaveBeenCalled();
    expect(onStartUpload).not.toHaveBeenCalled();
    expect(onCancelUpload).not.toHaveBeenCalled();
    expect(onRetryUpload).not.toHaveBeenCalled();
  });

  it("uses the offline lock before command execution", () => {
    render(<MyWork {...myWorkProps({
      online: false,
      capabilities: ["tasks.claim", "evidence.submit", "reservations.create", "recommendations.request"],
    })} />);
    expect(screen.getAllByText("离线时更改操作已锁定")).toHaveLength(5);
  });
});

describe("Processes workspace", () => {
  it("renders canonical tabs and independent cohort/process search controls", () => {
    const onTabChange = vi.fn();
    const onQueryChange = vi.fn();
    render(<Processes {...processProps({ onTabChange, onQueryChange })} />);

    const tabs = screen.getByRole("tablist", { name: "流程视图" });
    for (const tab of WORKSPACE_DEFINITIONS.processes.tabs) {
      fireEvent.click(within(tabs).getByRole("tab", { name: tab.label }));
      expect(onTabChange).toHaveBeenLastCalledWith(tab.id);
    }
    fireEvent.change(screen.getByLabelText("搜索群组"), { target: { value: "2026 春季" } });
    fireEvent.change(screen.getByLabelText("搜索流程"), { target: { value: "电子模块" } });
    expect(onQueryChange).toHaveBeenLastCalledWith({
      search: "",
      filters: { cohort: "2026 春季", process: "电子模块" },
      sort: "updated-desc",
    });
  });

  it("presents process progress, participants, tasks, evidence, risks, and timeline semantically", () => {
    render(<Processes {...processProps({
      result: {
        state: "ready",
        items: [{ id: "process-1", process: "电子模块", cohort: "2026 春季", owner: "课程负责人", status: "ACTIVE" }],
        count: 1,
        fetchedAt,
      },
      selectedProcess: {
        id: "process-1",
        progress: 65,
        participants: [{ id: "person-1", name: "参与者甲", role: "成员" }],
        tasks: [{ id: "task-1", name: "安全检查", state: "COMPLETED" }],
        evidence: [{ id: "evidence-1", name: "检查记录", state: "ACCEPTED" }],
        risks: [{ id: "risk-1", name: "设备冲突", severity: "HIGH" }],
        timeline: [{ id: "event-1", occurredAt: "2026-08-01T10:00:00Z", label: "流程已启动" }],
      },
    })} />);

    expect(screen.getByRole("progressbar", { name: "流程进度" })).toHaveAttribute("value", "65");
    expect(screen.getByRole("list", { name: "参与者" })).toHaveTextContent("参与者甲");
    expect(screen.getByRole("list", { name: "任务" })).toHaveTextContent("安全检查");
    expect(screen.getByRole("list", { name: "证据" })).toHaveTextContent("检查记录");
    expect(screen.getByRole("list", { name: "风险" })).toHaveTextContent("设备冲突");
    expect(screen.getByRole("list", { name: "时间线" })).toHaveTextContent("流程已启动");
    expect(document.body).not.toHaveTextContent(/示例|sample|demo/i);
  });

  it("uses exact create/start/suspend/cancel metadata and fails closed for missing contracts", () => {
    execute.mockClear();
    const { container } = render(<Processes {...processProps({
      capabilities: ["cohorts.create", "processes.start", "processes.suspend", "processes.cancel"],
      selectedProcess: { id: "process-1", progress: 0, participants: [], tasks: [], evidence: [], risks: [], timeline: [] },
    })} />);

    expect(screen.getByLabelText("工作区合同不可用")).toHaveTextContent("/cohorts、/processes、/tasks");
    for (const command of WORKSPACE_DEFINITIONS.processes.commands) {
      const button = screen.getByRole("button", { name: command.label });
      expect(button).toBeDisabled();
      if (command.availability.state !== "unavailable") throw new Error("test requires unavailable metadata");
      expect(document.body).toHaveTextContent(command.availability.message);
    }
    expect(screen.getByLabelText("群组名称")).toBeDisabled();
    expect(screen.getByLabelText("流程定义")).toBeDisabled();
    expect(screen.getByLabelText("暂停或取消原因")).toBeDisabled();
    for (const form of container.querySelectorAll("form.command-panel")) fireEvent.submit(form);
    expect(execute).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent(/示例|sample|demo/i);
  });

  it("locks process commands for missing capabilities and offline mode", () => {
    const { rerender } = render(<Processes {...processProps()} />);
    for (const command of WORKSPACE_DEFINITIONS.processes.commands) {
      expect(screen.getByText(`缺少能力：${command.capability}`)).toBeInTheDocument();
    }

    rerender(<Processes {...processProps({
      online: false,
      capabilities: ["cohorts.create", "processes.start", "processes.suspend", "processes.cancel"],
    })} />);
    expect(screen.getAllByText("离线时更改操作已锁定")).toHaveLength(4);
  });
});
