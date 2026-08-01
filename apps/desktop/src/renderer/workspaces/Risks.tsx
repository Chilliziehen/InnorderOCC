import type { CommandReceipt, WorkspaceCommand, WorkspaceResult } from "../../desktop-contract";
import { z } from "zod";

import { CommandPanel } from "../components/CommandPanel";
import { QueryToolbar, type WorkspaceQueryValue } from "../components/QueryToolbar";
import { WorkspaceState } from "../components/WorkspaceState";
import { WORKSPACE_DEFINITIONS, type WorkspaceDefinition } from "./workspace-definitions";

export type RiskTab = "open" | "mine" | "resolved";

const riskTabs: readonly { id: RiskTab; label: string }[] = [
  { id: "open", label: "未解决" },
  { id: "mine", label: "我的风险" },
  { id: "resolved", label: "已解决" },
];

const riskDefinition: WorkspaceDefinition = {
  ...WORKSPACE_DEFINITIONS.risks,
  filters: WORKSPACE_DEFINITIONS.risks.filters.map((filter) => filter.key === "owner" ? {
    ...filter,
    options: [{ value: "mine", label: "由我负责" }, { value: "unassigned", label: "未分派" }],
  } : filter),
};

export const riskItemSchema = z.object({
  id: z.string().min(1),
  risk: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low"]),
  owner: z.string().min(1).nullable(),
  status: z.string().min(1),
  deadline: z.iso.datetime({ offset: true }),
  sla: z.enum(["on-track", "due-soon", "overdue"]),
}).strict();

type RiskItem = z.infer<typeof riskItemSchema>;

const severityLabels: Readonly<Record<RiskItem["severity"], string>> = {
  critical: "严重",
  high: "高",
  medium: "中",
  low: "低",
};
const slaLabels: Readonly<Record<RiskItem["sla"], string>> = {
  "on-track": "SLA 正常",
  "due-soon": "即将到期",
  overdue: "已逾期",
};

export interface RisksProps {
  readonly result: WorkspaceResult;
  readonly query: WorkspaceQueryValue;
  readonly activeTab: RiskTab;
  readonly selectedRiskId?: string;
  readonly capabilities: readonly string[];
  readonly online: boolean;
  readonly authenticated: boolean;
  readonly onTabChange: (tab: RiskTab) => void;
  readonly onQueryChange: (query: WorkspaceQueryValue) => void;
  readonly onRefresh: () => void;
  readonly onExecute: (intent: WorkspaceCommand) => Promise<CommandReceipt>;
}

function RiskRow(item: RiskItem) {
  return (
    <div role="row" aria-label={item.risk}>
      <span role="cell">{item.risk}</span>
      <span role="cell">严重性：{severityLabels[item.severity]}</span>
      <span role="cell">负责人：{item.owner ?? "未分派"}</span>
      <span role="cell">状态：{item.status}</span>
      <span role="cell">时限：<time dateTime={item.deadline}>{new Date(item.deadline).toLocaleString("zh-CN")}</time></span>
      <span role="cell">SLA：{slaLabels[item.sla]}</span>
    </div>
  );
}

export function Risks({ result, query, activeTab, selectedRiskId, capabilities, online, authenticated, onTabChange, onQueryChange, onRefresh, onExecute }: RisksProps) {
  const readOnly = !online || result.state === "offline" || result.state === "stale";
  return (
    <section aria-labelledby="risks-title">
      <header><h1 id="risks-title">风险</h1></header>
      <div role="tablist" aria-label="风险视图">
        {riskTabs.map((tab) => <button type="button" role="tab" aria-selected={activeTab === tab.id} key={tab.id} onClick={() => onTabChange(tab.id)}>{tab.label}</button>)}
      </div>
      <QueryToolbar definition={riskDefinition} value={query} disabled={readOnly} onChange={onQueryChange} onRefresh={onRefresh} />
      <WorkspaceState result={result} itemSchema={riskItemSchema} onRetry={onRefresh} onRefresh={onRefresh} renderItem={RiskRow} />
      <section aria-label="风险操作">
        {WORKSPACE_DEFINITIONS.risks.commands.map((command) => (
          <CommandPanel
            key={command.operation}
            workspace="risks"
            command={command}
            capabilities={capabilities}
            online={online && !readOnly}
            authenticated={authenticated}
            payload={{}}
            {...(selectedRiskId ? { targetId: selectedRiskId } : {})}
            onExecute={onExecute}
            onConflictRefresh={onRefresh}
          />
        ))}
      </section>
    </section>
  );
}
