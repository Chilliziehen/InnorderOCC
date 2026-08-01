import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const metadataMode = vi.hoisted(() => ({ available: false, unavailable: new Set<string>() }));

vi.mock("../src/renderer/workspaces/workspace-definitions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/renderer/workspaces/workspace-definitions")>();
  return {
    ...actual,
    commandFor: (workspace: Parameters<typeof actual.commandFor>[0], operationName: string) => {
      const operation = actual.commandFor(workspace, operationName);
      const workspaceId = typeof workspace === "string" ? workspace : workspace.id;
      if (!operation || !metadataMode.available || metadataMode.unavailable.has(`${workspaceId}:${operationName}`)) return operation;
      return { ...operation, availability: { state: "available" as const } };
    },
  };
});

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

beforeEach(() => {
  metadataMode.available = false;
  metadataMode.unavailable.clear();
  execute.mockClear();
});

const allWorkCapabilities = ["tasks.claim", "evidence.submit", "reservations.create", "recommendations.request"];
const allProcessCapabilities = ["cohorts.create", "processes.start", "processes.suspend", "processes.cancel"];

function selectedTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-17",
    evidenceRequirements: ["校准记录 PDF"],
    acceptedMediaTypes: ["application/pdf"],
    reviewHistory: [],
    ...overrides,
  };
}

function selectedProcess(overrides: Record<string, unknown> = {}) {
  return {
    id: "process-1",
    expectedVersion: 7,
    progress: 0,
    participants: [],
    tasks: [],
    evidence: [],
    risks: [],
    timeline: [],
    ...overrides,
  };
}

function formFor(buttonName: string): HTMLFormElement {
  const form = screen.getByRole("button", { name: buttonName }).closest("form");
  if (!form) throw new Error(`No command form for ${buttonName}`);
  return form;
}

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
      expect(control).toHaveAttribute("aria-controls", `my-work-panel-${tab.id}`);
      expect(control).toHaveAttribute("tabindex", tab.id === "available" ? "0" : "-1");
      expect(document.getElementById(`my-work-panel-${tab.id}`)).toHaveAttribute("role", "tabpanel");
      fireEvent.click(control);
      expect(onTabChange).toHaveBeenLastCalledWith(tab.id);
    }
  });

  it("moves tab focus with wrapped arrows, Home, and End", () => {
    const onTabChange = vi.fn();
    render(<MyWork {...myWorkProps({ onTabChange })} />);
    const tabs = screen.getAllByRole("tab");

    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: "ArrowLeft" });
    expect(tabs.at(-1)).toHaveFocus();
    expect(onTabChange).toHaveBeenLastCalledWith("completed");
    fireEvent.keyDown(tabs.at(-1)!, { key: "Home" });
    expect(tabs[0]).toHaveFocus();
    fireEvent.keyDown(tabs[0]!, { key: "End" });
    expect(tabs.at(-1)).toHaveFocus();
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
        acceptedMediaTypes: ["application/pdf"],
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
    fireEvent.submit(formFor("重试上传"));
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
      selectedTask: { id: "task-17", evidenceRequirements: [], acceptedMediaTypes: ["application/pdf"], reviewHistory: [] },
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
    const cancelUpload = screen.getByRole("button", { name: "取消上传" });
    expect(cancelUpload).toBeDisabled();
    fireEvent.submit(formFor("取消上传"));
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

  it("guards claim in the submit handler until a target task exists", async () => {
    metadataMode.available = true;
    render(<MyWork {...myWorkProps({ capabilities: allWorkCapabilities })} />);
    const claim = screen.getByRole("button", { name: "领取任务" });
    expect(claim).toBeDisabled();
    expect(screen.getByText("请选择任务后再领取")).toHaveAttribute("role", "alert");
    fireEvent.submit(formFor("领取任务"));
    await waitFor(() => expect(execute).not.toHaveBeenCalled());
  });

  it("starts and submits only bounded evidence matching task media metadata and an upload reference", async () => {
    metadataMode.available = true;
    const onStartUpload = vi.fn();
    const { rerender } = render(<MyWork {...myWorkProps({
      capabilities: allWorkCapabilities,
      selectedTask: selectedTask(),
      onStartUpload,
    })} />);
    const input = screen.getByLabelText("选择证据文件");
    expect(input).toHaveAttribute("accept", "application/pdf");
    const file = new File(["pdf"], "record.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [file] } });

    fireEvent.click(screen.getByRole("button", { name: "开始上传" }));
    expect(onStartUpload).toHaveBeenCalledWith(file, "task-17");
    expect(screen.getByRole("button", { name: "提交证据" })).toBeDisabled();
    expect(screen.getByText("缺少证据上传引用")).toHaveAttribute("role", "alert");
    fireEvent.submit(formFor("提交证据"));
    expect(execute).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "提交证据" })).toBeDisabled());

    rerender(<MyWork {...myWorkProps({
      capabilities: allWorkCapabilities,
      selectedTask: selectedTask(),
      uploadReference: "upload-17",
      onStartUpload,
    })} />);
    fireEvent.click(screen.getByRole("button", { name: "提交证据" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      operation: "submitEvidence",
      targetId: "task-17",
      payload: expect.objectContaining({ taskId: "task-17", uploadReference: "upload-17" }),
    })));
  });

  it.each([
    { name: "oversized", type: "application/pdf", size: 100 * 1024 * 1024 + 1, error: "证据文件不得超过 100 MiB" },
    { name: "wrong-media", type: "image/png", size: 3, error: "文件媒体类型不在任务允许范围内" },
  ])("rejects $name evidence in UI and forged handlers", async ({ type, size, error }) => {
    metadataMode.available = true;
    const onStartUpload = vi.fn();
    render(<MyWork {...myWorkProps({ capabilities: allWorkCapabilities, selectedTask: selectedTask(), uploadReference: "upload-17", onStartUpload })} />);
    const file = new File(["bad"], "record.bin", { type });
    Object.defineProperty(file, "size", { value: size });
    fireEvent.change(screen.getByLabelText("选择证据文件"), { target: { files: [file] } });

    const start = screen.getByRole("button", { name: "开始上传" });
    expect(start).toBeDisabled();
    expect(screen.getAllByText(error).every((element) => element.getAttribute("role") === "alert")).toBe(true);
    fireEvent.submit(formFor("开始上传"));
    fireEvent.submit(formFor("提交证据"));
    await waitFor(() => {
      expect(onStartUpload).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });
  });

  it("requires task, resource, and an ordered reservation interval before execution", async () => {
    metadataMode.available = true;
    render(<MyWork {...myWorkProps({ capabilities: allWorkCapabilities, selectedTask: selectedTask() })} />);
    expect(screen.getByRole("button", { name: "预留资源" })).toBeDisabled();
    fireEvent.submit(formFor("预留资源"));
    expect(execute).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "预留资源" })).toBeDisabled());

    fireEvent.change(screen.getByLabelText("资源 ID"), { target: { value: "bench-4" } });
    fireEvent.change(screen.getByLabelText("开始时间"), { target: { value: "2026-08-03T10:00" } });
    fireEvent.change(screen.getByLabelText("结束时间"), { target: { value: "2026-08-03T08:00" } });
    expect(screen.getByRole("button", { name: "预留资源" })).toBeDisabled();
    expect(screen.getByText("预留时间范围无效")).toHaveAttribute("role", "alert");
    fireEvent.submit(formFor("预留资源"));
    expect(execute).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "预留资源" })).toBeDisabled());

    fireEvent.change(screen.getByLabelText("开始时间"), { target: { value: "2026-08-03T08:00" } });
    fireEvent.change(screen.getByLabelText("结束时间"), { target: { value: "2026-08-03T10:00" } });
    fireEvent.click(screen.getByRole("button", { name: "预留资源" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      operation: "reserve",
      targetId: "task-17",
      payload: { taskId: "task-17", resourceId: "bench-4", startsAt: "2026-08-03T08:00", endsAt: "2026-08-03T10:00" },
    })));
  });

  it("guards AI guidance against a missing task even under forced submission", () => {
    metadataMode.available = true;
    render(<MyWork {...myWorkProps({ capabilities: allWorkCapabilities })} />);
    expect(screen.getByRole("button", { name: "请求智能建议" })).toBeDisabled();
    expect(screen.getByText("请选择任务后再请求智能建议")).toHaveAttribute("role", "alert");
    fireEvent.submit(formFor("请求智能建议"));
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("Processes workspace", () => {
  it("renders canonical tabs and independent cohort/process search controls", () => {
    const onTabChange = vi.fn();
    const onQueryChange = vi.fn();
    render(<Processes {...processProps({ onTabChange, onQueryChange })} />);

    const tabs = screen.getByRole("tablist", { name: "流程视图" });
    for (const tab of WORKSPACE_DEFINITIONS.processes.tabs) {
      const control = within(tabs).getByRole("tab", { name: tab.label });
      expect(control).toHaveAttribute("aria-controls", `processes-panel-${tab.id}`);
      expect(control).toHaveAttribute("tabindex", tab.id === "cohorts" ? "0" : "-1");
      expect(document.getElementById(`processes-panel-${tab.id}`)).toHaveAttribute("role", "tabpanel");
      fireEvent.click(control);
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

  it("moves process tab focus with wrapped arrows, Home, and End", () => {
    const onTabChange = vi.fn();
    render(<Processes {...processProps({ onTabChange })} />);
    const tabs = screen.getAllByRole("tab");

    tabs.at(-1)!.focus();
    fireEvent.keyDown(tabs.at(-1)!, { key: "ArrowRight" });
    expect(tabs[0]).toHaveFocus();
    expect(onTabChange).toHaveBeenLastCalledWith("cohorts");
    fireEvent.keyDown(tabs[0]!, { key: "End" });
    expect(tabs.at(-1)).toHaveFocus();
    fireEvent.keyDown(tabs.at(-1)!, { key: "Home" });
    expect(tabs[0]).toHaveFocus();
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
        expectedVersion: 7,
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
      selectedProcess: { id: "process-1", expectedVersion: 7, progress: 0, participants: [], tasks: [], evidence: [], risks: [], timeline: [] },
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

  it("guards cohort creation and process start shapes before callbacks", async () => {
    metadataMode.available = true;
    const { rerender } = render(<Processes {...processProps({ capabilities: allProcessCapabilities })} />);
    expect(screen.getByRole("button", { name: "创建群组" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "启动流程" })).toBeDisabled();
    fireEvent.submit(formFor("创建群组"));
    fireEvent.submit(formFor("启动流程"));
    expect(execute).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "创建群组" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "启动流程" })).toBeDisabled();
    });

    fireEvent.change(screen.getByLabelText("群组名称"), { target: { value: " 2026 春季 " } });
    fireEvent.click(screen.getByRole("button", { name: "创建群组" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith(expect.objectContaining({ operation: "create", payload: { name: "2026 春季" } })));

    execute.mockClear();
    fireEvent.change(screen.getByLabelText("流程定义"), { target: { value: "electronics-v2" } });
    expect(screen.getByRole("button", { name: "启动流程" })).toBeDisabled();
    expect(screen.getByText("请选择要启动的流程")).toHaveAttribute("role", "alert");
    fireEvent.submit(formFor("启动流程"));
    expect(execute).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "启动流程" })).toBeDisabled());

    rerender(<Processes {...processProps({ capabilities: allProcessCapabilities, selectedProcess: selectedProcess() })} />);
    fireEvent.click(screen.getByRole("button", { name: "启动流程" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith(expect.objectContaining({ operation: "start", targetId: "process-1" })));
  });

  it("guards suspend and cancel independently with target, reason, and expectedVersion", async () => {
    metadataMode.available = true;
    const { rerender } = render(<Processes {...processProps({ capabilities: allProcessCapabilities, selectedProcess: selectedProcess({ expectedVersion: -1 }) })} />);
    expect(screen.getByRole("button", { name: "暂停流程" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "取消流程" })).toBeDisabled();
    fireEvent.submit(formFor("暂停流程"));
    fireEvent.submit(formFor("取消流程"));
    expect(execute).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "暂停流程" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "取消流程" })).toBeDisabled();
    });

    fireEvent.change(screen.getByLabelText("暂停或取消原因"), { target: { value: " 维护窗口 " } });
    expect(screen.getAllByText("缺少有效的流程版本").every((element) => element.getAttribute("role") === "alert")).toBe(true);
    fireEvent.submit(formFor("暂停流程"));
    fireEvent.submit(formFor("取消流程"));
    expect(execute).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "暂停流程" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "取消流程" })).toBeDisabled();
    });

    rerender(<Processes {...processProps({ capabilities: allProcessCapabilities, selectedProcess: selectedProcess() })} />);
    fireEvent.click(screen.getByRole("button", { name: "暂停流程" }));
    fireEvent.click(screen.getByRole("button", { name: "取消流程" }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    for (const operation of ["suspend", "cancel"]) {
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({
        operation,
        targetId: "process-1",
        payload: { reason: "维护窗口", expectedVersion: 7 },
      }));
    }
  });

  it("keeps the shared reason editable when either suspend or cancel remains available", () => {
    metadataMode.available = true;
    metadataMode.unavailable.add("processes:suspend");
    render(<Processes {...processProps({ capabilities: allProcessCapabilities, selectedProcess: selectedProcess() })} />);
    expect(screen.getByLabelText("暂停或取消原因")).toBeEnabled();
    expect(screen.getByRole("button", { name: "暂停流程" })).toBeDisabled();
  });
});
