import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CommandReceipt, WorkspaceCommand, WorkspaceResult } from "../src/desktop-contract";
import { Interventions, type InterventionsProps } from "../src/renderer/workspaces/Interventions";
import { Risks, type RisksProps } from "../src/renderer/workspaces/Risks";

const fetchedAt = "2026-08-01T12:00:00.000Z";
const correlationId = "00000000-0000-4000-8000-000000000099";
const unavailableInterventions: WorkspaceResult = {
  state: "unavailable",
  reason: "UNAVAILABLE_CONTRACT",
  resourceGroups: ["/evidence", "/risks", "/recommendations", "/audit"],
  message: "人工介入 API 合同尚未集成",
};
const unavailableRisks: WorkspaceResult = {
  state: "unavailable",
  reason: "UNAVAILABLE_CONTRACT",
  resourceGroups: ["/risks"],
  message: "风险 API 合同尚未集成",
};

function interventionProps(overrides: Partial<InterventionsProps> = {}): InterventionsProps {
  return {
    result: unavailableInterventions,
    query: { search: "", filters: {}, sort: "created-desc" },
    activeTab: "evidence-reviews",
    selectedItemId: "intervention-1",
    capabilities: [],
    online: true,
    authenticated: true,
    onTabChange: vi.fn(),
    onQueryChange: vi.fn(),
    onRefresh: vi.fn(),
    onExecute: vi.fn<(intent: WorkspaceCommand) => Promise<CommandReceipt>>(),
    ...overrides,
  };
}

function riskProps(overrides: Partial<RisksProps> = {}): RisksProps {
  return {
    result: unavailableRisks,
    query: { search: "", filters: {}, sort: "severity-desc" },
    activeTab: "open",
    selectedRiskId: "risk-1",
    capabilities: [],
    online: true,
    authenticated: true,
    onTabChange: vi.fn(),
    onQueryChange: vi.fn(),
    onRefresh: vi.fn(),
    onExecute: vi.fn<(intent: WorkspaceCommand) => Promise<CommandReceipt>>(),
    ...overrides,
  };
}

describe("Interventions", () => {
  it("exposes all five intervention queues and controlled type/status filters", () => {
    const onTabChange = vi.fn();
    const onQueryChange = vi.fn();
    render(<Interventions {...interventionProps({ onTabChange, onQueryChange })} />);

    const tabs = within(screen.getByRole("tablist", { name: "介入队列" }));
    for (const label of ["证据审核", "异常", "自动化失败", "策略阻断", "智能建议"]) {
      expect(tabs.getByRole("tab", { name: label })).toBeInTheDocument();
    }
    expect(tabs.getByRole("tab", { name: "证据审核" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(tabs.getByRole("tab", { name: "自动化失败" }));
    expect(onTabChange).toHaveBeenCalledWith("failed-automation");

    fireEvent.change(screen.getByLabelText("介入类型"), { target: { value: "policy" } });
    fireEvent.change(screen.getByLabelText("状态"), { target: { value: "open" } });
    expect(onQueryChange).toHaveBeenLastCalledWith(expect.objectContaining({ filters: { type: "policy", status: "open" } }));
  });

  it("binds review actions to exact capabilities and unavailable reasons", () => {
    render(<Interventions {...interventionProps({ capabilities: ["evidence.review", "interventions.resolve"] })} />);

    const expected = [
      ["接受", "证据审核 API 合同尚未集成"],
      ["有条件接受", "证据审核 API 合同尚未集成"],
      ["拒绝", "证据审核 API 合同尚未集成"],
      ["退回", "介入退回 API 合同尚未集成"],
    ] as const;
    for (const [label, reason] of expected) {
      const button = screen.getByRole("button", { name: label });
      expect(button).toBeDisabled();
      const reasonNode = screen.getAllByText(reason).find((node) => node.id === button.getAttribute("aria-describedby"));
      expect(reasonNode).toBeDefined();
    }
  });

  it("shows exact missing capability and offline locks without submitting", () => {
    const onExecute = vi.fn();
    const { rerender } = render(<Interventions {...interventionProps({ onExecute })} />);
    const accept = screen.getByRole("button", { name: "接受" });
    expect(document.getElementById(accept.getAttribute("aria-describedby")!)).toHaveTextContent("缺少能力：evidence.review");

    rerender(<Interventions {...interventionProps({ capabilities: ["evidence.review", "interventions.resolve"], online: false, onExecute })} />);
    expect(screen.getAllByText("离线时更改操作已锁定")).toHaveLength(4);
    expect(screen.getByLabelText("搜索")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "接受" }));
    expect(onExecute).not.toHaveBeenCalled();
  });

  it("renders cited, stale, and unavailable recommendation trust states", () => {
    const result: WorkspaceResult = {
      state: "ready",
      count: 3,
      fetchedAt,
      items: [
        { id: "i-1", item: "核验发票", type: "recommendation", owner: "李明", status: "open", recommendation: { state: "cited", summary: "与采购单一致", citations: ["evidence:ev-17"] } },
        { id: "i-2", item: "检查供应商", type: "recommendation", owner: null, status: "open", recommendation: { state: "stale", summary: "供应商信息可能过期", asOf: "2026-07-31T08:00:00.000Z" } },
        { id: "i-3", item: "评估例外", type: "recommendation", owner: null, status: "open", recommendation: { state: "unavailable", reason: "建议服务不可用" } },
      ],
    };
    render(<Interventions {...interventionProps({ result, activeTab: "ai-recommendations" })} />);

    expect(screen.getByLabelText("有引用的智能建议")).toHaveTextContent("evidence:ev-17");
    expect(screen.getByLabelText("过期的智能建议")).toHaveTextContent("2026");
    expect(screen.getByLabelText("智能建议不可用")).toHaveTextContent("建议服务不可用");
  });

  it("delegates error retry and conflict refresh to shared state controls", () => {
    const onRefresh = vi.fn();
    const { rerender } = render(<Interventions {...interventionProps({ result: { state: "error", problem: { title: "查询失败", code: "QUERY_FAILED", status: 503, correlationId } }, onRefresh })} />);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRefresh).toHaveBeenCalledOnce();

    rerender(<Interventions {...interventionProps({ result: { state: "conflict", currentVersion: 12, correlationId }, onRefresh })} />);
    expect(screen.getByRole("region", { name: "版本冲突" })).toHaveTextContent("当前版本 12");
    fireEvent.click(screen.getByRole("button", { name: "刷新当前版本" }));
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });
});

describe("Risks", () => {
  it("exposes severity, SLA, owner, and status filters plus ownership tabs", () => {
    const onTabChange = vi.fn();
    render(<Risks {...riskProps({ onTabChange })} />);

    const tabs = within(screen.getByRole("tablist", { name: "风险视图" }));
    expect(tabs.getByRole("tab", { name: "未解决" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(tabs.getByRole("tab", { name: "我的风险" }));
    expect(onTabChange).toHaveBeenCalledWith("mine");
    for (const filter of ["严重性", "SLA", "负责人", "状态"]) expect(screen.getByLabelText(filter)).toBeInTheDocument();
  });

  it("locks all five risk operations with their exact capabilities and production reason", () => {
    render(<Risks {...riskProps({ capabilities: ["risks.acknowledge", "risks.assign", "risks.mitigate", "risks.escalate", "risks.resolve"] })} />);

    for (const label of ["确认风险", "分派风险", "记录缓解", "升级风险", "解决风险"]) {
      const button = screen.getByRole("button", { name: label });
      expect(button).toBeDisabled();
      expect(document.getElementById(button.getAttribute("aria-describedby")!)).toHaveTextContent(new RegExp(`风险(?:确认|分派|缓解|升级|解决) API 合同尚未集成`));
    }
  });

  it("renders severity as text with ownership, deadline, and SLA", () => {
    const result: WorkspaceResult = {
      state: "ready",
      count: 2,
      fetchedAt,
      items: [
        { id: "r-1", risk: "关键供应商中断", severity: "critical", owner: "王芳", status: "open", deadline: "2026-08-01T15:00:00.000Z", sla: "due-soon" },
        { id: "r-2", risk: "审查逾期", severity: "high", owner: null, status: "acknowledged", deadline: "2026-07-31T15:00:00.000Z", sla: "overdue" },
      ],
    };
    render(<Risks {...riskProps({ result })} />);

    expect(screen.getByRole("row", { name: /关键供应商中断/ })).toHaveTextContent("严重");
    expect(screen.getByRole("row", { name: /关键供应商中断/ })).toHaveTextContent("王芳");
    expect(screen.getByRole("row", { name: /关键供应商中断/ })).toHaveTextContent("即将到期");
    expect(screen.getByRole("row", { name: /审查逾期/ })).toHaveTextContent("未分派");
    expect(screen.getByRole("row", { name: /审查逾期/ })).toHaveTextContent("已逾期");
    expect(within(screen.getByRole("row", { name: /关键供应商中断/ })).getByRole("time")).toHaveAttribute("dateTime", "2026-08-01T15:00:00.000Z");
    expect(within(screen.getByRole("row", { name: /审查逾期/ })).getByRole("time")).toHaveAttribute("dateTime", "2026-07-31T15:00:00.000Z");
  });

  it("uses shared offline and conflict semantics and never invents data", () => {
    const onRefresh = vi.fn();
    const offline: WorkspaceResult = { state: "offline", count: 1, fetchedAt, items: [{ id: "r-1", risk: "缓存风险", severity: "low", owner: null, status: "open", deadline: "2026-08-02T15:00:00.000Z", sla: "on-track" }] };
    const { rerender } = render(<Risks {...riskProps({ result: offline, online: false, onRefresh })} />);
    expect(screen.getByText("离线数据，只读")).toBeInTheDocument();
    expect(screen.getByLabelText("搜索")).toBeDisabled();
    expect(screen.getByRole("row", { name: /缓存风险/ })).toBeInTheDocument();

    rerender(<Risks {...riskProps({ result: { state: "conflict", currentVersion: 7 }, onRefresh })} />);
    fireEvent.click(screen.getByRole("button", { name: "刷新当前版本" }));
    expect(onRefresh).toHaveBeenCalledOnce();

    rerender(<Risks {...riskProps()} />);
    expect(screen.getByLabelText("工作区合同不可用")).toHaveTextContent("/risks");
    expect(screen.queryByRole("row", { name: /缓存风险/ })).not.toBeInTheDocument();
  });
});
