import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CommandReceipt, WorkspaceCommand, WorkspaceResult } from "../src/desktop-contract";
import {
  Interventions,
  interventionCommandPayloadSchemas,
  interventionItemSchema,
  reviewTargetGateReason,
  type InterventionsProps,
} from "../src/renderer/workspaces/Interventions";
import {
  Risks,
  riskCommandPayloadSchemas,
  type RisksProps,
} from "../src/renderer/workspaces/Risks";

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
    activeTab: "reviews",
    selectedItemId: "intervention-1",
    capabilities: [],
    online: true,
    authenticated: true,
    onTabChange: vi.fn(),
    onSelectItem: vi.fn(),
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
    onSelectRisk: vi.fn(),
    onQueryChange: vi.fn(),
    onRefresh: vi.fn(),
    onExecute: vi.fn<(intent: WorkspaceCommand) => Promise<CommandReceipt>>(),
    ...overrides,
  };
}

const interventionItems: WorkspaceResult = {
  state: "ready",
  count: 2,
  fetchedAt,
  items: [
    { id: "i-1", item: "核验发票", type: "review", owner: "李明", status: "open", version: 7, evidenceVersion: 3 },
    { id: "i-2", item: "检查供应商", type: "recommendation", owner: null, status: "open", version: 4, recommendation: { state: "cited", summary: "与采购单一致", citations: ["evidence:ev-17"] } },
  ],
};

const riskItems: WorkspaceResult = {
  state: "ready",
  count: 2,
  fetchedAt,
  items: [
    { id: "r-1", risk: "关键供应商中断", severity: "critical", owner: "王芳", status: "open", deadline: "2026-08-01T15:00:00.000Z", sla: "due-soon", version: 8 },
    { id: "r-2", risk: "审查逾期", severity: "high", owner: null, status: "acknowledged", deadline: "2026-07-31T15:00:00.000Z", sla: "overdue", version: 5 },
  ],
};

describe("Interventions", () => {
  it("consumes the five canonical tabs with an associated tabpanel", () => {
    const onTabChange = vi.fn();
    render(<Interventions {...interventionProps({ onTabChange })} />);
    const tabs = within(screen.getByRole("tablist", { name: "介入队列" }));
    for (const label of ["证据审核", "异常", "自动化失败", "策略阻断", "智能建议"]) expect(tabs.getByRole("tab", { name: label })).toBeInTheDocument();
    const selected = tabs.getByRole("tab", { name: "证据审核" });
    expect(selected).toHaveAttribute("id", "interventions-tab-reviews");
    expect(selected).toHaveAttribute("aria-controls", "interventions-panel");
    expect(selected).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", selected.id);
    expect(tabs.getByRole("tab", { name: "异常" })).toHaveAttribute("tabindex", "-1");
  });

  it("implements roving Arrow, Home, and End tab navigation", () => {
    const onTabChange = vi.fn();
    render(<Interventions {...interventionProps({ onTabChange })} />);
    const tabs = within(screen.getByRole("tablist", { name: "介入队列" }));
    const review = tabs.getByRole("tab", { name: "证据审核" });
    review.focus();
    fireEvent.keyDown(review, { key: "ArrowRight" });
    expect(onTabChange).toHaveBeenLastCalledWith("exceptions");
    expect(tabs.getByRole("tab", { name: "异常" })).toHaveFocus();
    fireEvent.keyDown(tabs.getByRole("tab", { name: "异常" }), { key: "End" });
    expect(onTabChange).toHaveBeenLastCalledWith("ai");
    fireEvent.keyDown(tabs.getByRole("tab", { name: "智能建议" }), { key: "Home" });
    expect(onTabChange).toHaveBeenLastCalledWith("reviews");
  });

  it("selects validated rows and derives immutable review versions from the selected item", () => {
    const onSelectItem = vi.fn();
    render(<Interventions {...interventionProps({ result: interventionItems, selectedItemId: "i-1", onSelectItem })} />);
    const selector = screen.getByRole("button", { name: "选择介入事项：检查供应商" });
    fireEvent.click(selector);
    expect(onSelectItem).toHaveBeenCalledWith("i-2");
    expect(screen.getByRole("button", { name: "选择介入事项：核验发票" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("证据版本：3")).toBeInTheDocument();
    expect(screen.getByText("预期版本：7")).toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "证据版本" })).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "预期版本" })).not.toBeInTheDocument();
    for (const label of ["有条件接受后续要求", "有条件接受到期日", "退回原因"]) expect(screen.getByLabelText(label)).toBeInTheDocument();
  });

  it("shows real unavailable contract reasons before target validation and blocks forged submit", () => {
    const onExecute = vi.fn();
    const { container } = render(<Interventions {...interventionProps({
      result: unavailableInterventions,
      selectedItemId: "i-2",
      capabilities: ["evidence.review", "interventions.resolve"],
      onExecute,
    })} />);
    const actions = screen.getByLabelText("介入操作");
    for (const label of ["接受", "有条件接受", "拒绝", "退回"]) {
      const button = within(actions).getByRole("button", { name: label });
      expect(button).toBeDisabled();
      expect(document.getElementById(button.getAttribute("aria-describedby")!)).toHaveTextContent(label === "退回" ? "介入退回 API 合同尚未集成" : "证据审核 API 合同尚未集成");
    }
    const forms = container.querySelectorAll("section[aria-label='介入操作'] form.command-panel");
    expect(forms).toHaveLength(4);
    for (const form of forms) fireEvent.submit(form);
    expect(onExecute).not.toHaveBeenCalled();
  });

  it("preserves canonical capability and offline precedence before target validation", () => {
    const { rerender } = render(<Interventions {...interventionProps({ result: interventionItems, selectedItemId: "i-2" })} />);
    expect(document.getElementById(screen.getByRole("button", { name: "接受" }).getAttribute("aria-describedby")!)).toHaveTextContent("缺少能力：evidence.review");
    expect(document.getElementById(screen.getByRole("button", { name: "退回" }).getAttribute("aria-describedby")!)).toHaveTextContent("缺少能力：interventions.resolve");

    rerender(<Interventions {...interventionProps({ result: interventionItems, selectedItemId: "i-2", online: false, capabilities: ["evidence.review", "interventions.resolve"] })} />);
    expect(screen.getAllByText("离线时更改操作已锁定")).toHaveLength(4);
    expect(screen.queryByText("仅证据审核事项可执行审核操作")).not.toBeInTheDocument();
  });

  it("applies review target validation only when the operation is otherwise available", () => {
    expect(reviewTargetGateReason({ operationAvailable: false, online: true, authenticated: true, capable: true, selectedType: "recommendation" })).toBeUndefined();
    expect(reviewTargetGateReason({ operationAvailable: true, online: false, authenticated: true, capable: true, selectedType: "recommendation" })).toBeUndefined();
    expect(reviewTargetGateReason({ operationAvailable: true, online: true, authenticated: true, capable: false, selectedType: "recommendation" })).toBeUndefined();
    expect(reviewTargetGateReason({ operationAvailable: true, online: true, authenticated: true, capable: true, selectedType: "recommendation" })).toBe("仅证据审核事项可执行审核操作");
    expect(reviewTargetGateReason({ operationAvailable: true, online: true, authenticated: true, capable: true })).toBe("请选择证据审核事项");
    expect(reviewTargetGateReason({ operationAvailable: true, online: true, authenticated: true, capable: true, selectedType: "review" })).toBeUndefined();
  });

  it("strictly validates each intervention operation payload", () => {
    expect(interventionCommandPayloadSchemas.accept.parse({ evidenceVersion: 3, expectedVersion: 7 })).toEqual({ evidenceVersion: 3, expectedVersion: 7 });
    expect(() => interventionCommandPayloadSchemas.accept.parse({ evidenceVersion: -1, expectedVersion: 7 })).toThrow();
    expect(interventionCommandPayloadSchemas.conditional.parse({ evidenceVersion: 3, expectedVersion: 7, followUp: "补交签收单", dueAt: "2026-08-03" })).toBeTruthy();
    expect(() => interventionCommandPayloadSchemas.conditional.parse({ evidenceVersion: 3, expectedVersion: 7, followUp: "", dueAt: "" })).toThrow();
    expect(interventionCommandPayloadSchemas.reject.parse({ evidenceVersion: 3, expectedVersion: 7 })).toBeTruthy();
    expect(interventionCommandPayloadSchemas.return.parse({ expectedVersion: 7, reason: "证据主体不匹配" })).toBeTruthy();
    expect(() => interventionCommandPayloadSchemas.return.parse({ expectedVersion: 7, reason: " " })).toThrow();
  });

  it("requires trustworthy recommendation content and explicit non-generated states", () => {
    const base = { id: "i-1", item: "建议", type: "recommendation", owner: null, status: "open", version: 1 };
    expect(() => interventionItemSchema.parse(base)).toThrow();
    expect(() => interventionItemSchema.parse({ ...base, recommendation: { state: "cited", summary: "", citations: ["evidence:1"] } })).toThrow();
    expect(() => interventionItemSchema.parse({ ...base, recommendation: { state: "cited", summary: "有效建议", citations: [" "] } })).toThrow();
    expect(interventionItemSchema.parse({ ...base, recommendation: { state: "uncited-rejected", summary: "无来源建议", reason: "没有可验证引用" } })).toBeTruthy();
    expect(interventionItemSchema.parse({ ...base, recommendation: { state: "disabled", reason: "当前环境未启用智能服务" } })).toBeTruthy();
  });

  it("labels generated, stale, disabled, unavailable, and uncited rejection states", () => {
    const result: WorkspaceResult = {
      state: "ready", count: 5, fetchedAt, items: [
        { id: "i-1", item: "已引用", type: "recommendation", owner: null, status: "open", version: 1, recommendation: { state: "cited", summary: "建议", citations: ["evidence:1"] } },
        { id: "i-2", item: "已过期", type: "recommendation", owner: null, status: "open", version: 1, recommendation: { state: "stale", summary: "旧建议", asOf: "2026-07-31T08:00:00.000Z" } },
        { id: "i-3", item: "已禁用", type: "recommendation", owner: null, status: "open", version: 1, recommendation: { state: "disabled", reason: "策略禁用" } },
        { id: "i-4", item: "不可用", type: "recommendation", owner: null, status: "open", version: 1, recommendation: { state: "unavailable", reason: "服务不可用" } },
        { id: "i-5", item: "无引用", type: "recommendation", owner: null, status: "open", version: 1, recommendation: { state: "uncited-rejected", summary: "无来源建议", reason: "没有引用" } },
      ],
    };
    render(<Interventions {...interventionProps({ result, activeTab: "ai" })} />);
    expect(screen.getByLabelText("有引用的智能建议")).toHaveTextContent("建议已生成");
    expect(screen.getByLabelText("过期的智能建议")).toHaveTextContent("状态：已过期");
    expect(screen.getByLabelText("智能建议已禁用")).toHaveTextContent("策略禁用");
    expect(screen.getByLabelText("智能建议不可用")).toHaveTextContent("服务不可用");
    expect(screen.getByLabelText("无引用建议已拒绝")).toHaveTextContent("没有引用");
  });

  it("keeps refresh enabled while stale or offline and locks mutations", () => {
    const onRefresh = vi.fn();
    const stale: WorkspaceResult = { state: "stale", count: 1, fetchedAt, items: [interventionItems.items[0]!] };
    const { rerender } = render(<Interventions {...interventionProps({ result: stale, selectedItemId: "i-1", capabilities: ["evidence.review", "interventions.resolve"], onRefresh })} />);
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "接受" })).toBeDisabled();
    rerender(<Interventions {...interventionProps({ result: { ...stale, state: "offline" }, selectedItemId: "i-1", online: false, capabilities: ["evidence.review", "interventions.resolve"], onRefresh })} />);
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(onRefresh).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("离线时更改操作已锁定")).toHaveLength(4);
  });

  it("retains exact unavailable and shared error/conflict reasons", () => {
    const onRefresh = vi.fn();
    const { rerender } = render(<Interventions {...interventionProps({ result: unavailableInterventions, capabilities: ["evidence.review", "interventions.resolve"], onRefresh })} />);
    expect(document.getElementById(screen.getByRole("button", { name: "接受" }).getAttribute("aria-describedby")!)).toHaveTextContent("证据审核 API 合同尚未集成");
    rerender(<Interventions {...interventionProps({ result: { state: "error", problem: { title: "查询失败", code: "QUERY_FAILED", status: 503, correlationId } }, onRefresh })} />);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    rerender(<Interventions {...interventionProps({ result: { state: "conflict", currentVersion: 12, correlationId }, onRefresh })} />);
    fireEvent.click(screen.getByRole("button", { name: "刷新当前版本" }));
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });
});

describe("Risks", () => {
  it("renders canonical filters, accessible tabs, and an associated tabpanel", () => {
    render(<Risks {...riskProps()} />);
    for (const filter of ["严重性", "SLA", "负责人", "状态"]) expect(screen.getByLabelText(filter)).toBeInTheDocument();
    expect(within(screen.getByLabelText("SLA")).getByRole("option", { name: "正常" })).toHaveValue("on-track");
    const tab = screen.getByRole("tab", { name: "未解决" });
    expect(tab).toHaveAttribute("aria-controls", "risks-panel");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", tab.id);
  });

  it("supports roving risk tab navigation", () => {
    const onTabChange = vi.fn();
    render(<Risks {...riskProps({ onTabChange })} />);
    const open = screen.getByRole("tab", { name: "未解决" });
    fireEvent.keyDown(open, { key: "ArrowLeft" });
    expect(onTabChange).toHaveBeenCalledWith("resolved");
    expect(screen.getByRole("tab", { name: "已解决" })).toHaveFocus();
  });

  it("selects risks inside valid table ownership and exposes operation forms", () => {
    const onSelectRisk = vi.fn();
    render(<Risks {...riskProps({ result: riskItems, selectedRiskId: "r-1", onSelectRisk })} />);
    const firstRow = screen.getByRole("row", { name: /关键供应商中断/ });
    expect(firstRow.closest("table")).not.toBeNull();
    expect(within(firstRow).getByRole("button", { name: "选择风险：关键供应商中断" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "选择风险：审查逾期" }));
    expect(onSelectRisk).toHaveBeenCalledWith("r-2");
    for (const label of ["预期风险版本", "分派负责人", "缓解措施", "升级原因", "解决说明"]) expect(screen.getByLabelText(label)).toBeInTheDocument();
  });

  it("strictly validates every risk operation payload", () => {
    expect(riskCommandPayloadSchemas.acknowledge.parse({ expectedVersion: 8 })).toBeTruthy();
    expect(() => riskCommandPayloadSchemas.acknowledge.parse({ expectedVersion: -1 })).toThrow();
    expect(riskCommandPayloadSchemas.assign.parse({ expectedVersion: 8, assigneeId: "person-1" })).toBeTruthy();
    expect(() => riskCommandPayloadSchemas.assign.parse({ expectedVersion: 8, assigneeId: " " })).toThrow();
    expect(riskCommandPayloadSchemas.mitigate.parse({ expectedVersion: 8, mitigation: "启用备用供应商" })).toBeTruthy();
    expect(riskCommandPayloadSchemas.escalate.parse({ expectedVersion: 8, reason: "SLA 即将到期" })).toBeTruthy();
    expect(riskCommandPayloadSchemas.resolve.parse({ expectedVersion: 8, resolution: "备用供应商已接单" })).toBeTruthy();
  });

  it("renders severity, ownership, deadline, and textual SLA", () => {
    render(<Risks {...riskProps({ result: riskItems })} />);
    const critical = screen.getByRole("row", { name: /关键供应商中断/ });
    expect(critical).toHaveTextContent("严重性：严重");
    expect(critical).toHaveTextContent("王芳");
    expect(critical).toHaveTextContent("即将到期");
    expect(within(critical).getByRole("time")).toHaveAttribute("dateTime", "2026-08-01T15:00:00.000Z");
    expect(screen.getByRole("row", { name: /审查逾期/ })).toHaveTextContent("未分派");
  });

  it("keeps refresh enabled for offline data while risk mutations stay locked", () => {
    const onRefresh = vi.fn();
    const offline: WorkspaceResult = { state: "offline", count: 1, fetchedAt, items: [riskItems.items[0]!] };
    render(<Risks {...riskProps({ result: offline, online: false, capabilities: ["risks.acknowledge", "risks.assign", "risks.mitigate", "risks.escalate", "risks.resolve"], onRefresh })} />);
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(screen.getAllByText("离线时更改操作已锁定")).toHaveLength(5);
    expect(screen.getByRole("button", { name: "确认风险" })).toBeDisabled();
  });

  it("keeps exact production unavailable reasons and no invented rows", () => {
    render(<Risks {...riskProps({ capabilities: ["risks.acknowledge", "risks.assign", "risks.mitigate", "risks.escalate", "risks.resolve"] })} />);
    for (const label of ["确认风险", "分派风险", "记录缓解", "升级风险", "解决风险"]) {
      const button = screen.getByRole("button", { name: label });
      expect(button).toBeDisabled();
      expect(document.getElementById(button.getAttribute("aria-describedby")!)).toHaveTextContent(/风险(?:确认|分派|缓解|升级|解决) API 合同尚未集成/);
    }
    expect(screen.getByLabelText("工作区合同不可用")).toHaveTextContent("/risks");
    expect(screen.queryByRole("row")).not.toBeInTheDocument();
  });
});
