import { useRef, useState, type KeyboardEvent } from "react";
import { z } from "zod";

import type { CommandReceipt, WorkspaceCommand, WorkspaceResult } from "../../desktop-contract";
import { CommandPanel, useMainOperationAvailability } from "../components/CommandPanel";
import { QueryToolbar, type WorkspaceQueryValue } from "../components/QueryToolbar";
import { WorkspaceState } from "../components/WorkspaceState";
import { WORKSPACE_DEFINITIONS, type WorkspaceOperation } from "./workspace-definitions";

export type RiskTab = "open" | "mine" | "resolved";

const requiredText = z.string().trim().min(1);
const version = z.number().int().min(0);
export const riskItemSchema = z.object({
  id: requiredText,
  risk: requiredText,
  severity: z.enum(["critical", "high", "medium", "low"]),
  owner: requiredText.nullable(),
  status: requiredText,
  deadline: z.iso.datetime({ offset: true }),
  sla: z.enum(["on-track", "due-soon", "overdue"]),
  version,
}).strict();

export const riskCommandPayloadSchemas = {
  acknowledge: z.object({ expectedVersion: version }).strict(),
  assign: z.object({ expectedVersion: version, assigneeId: requiredText }).strict(),
  mitigate: z.object({ expectedVersion: version, mitigation: requiredText }).strict(),
  escalate: z.object({ expectedVersion: version, reason: requiredText }).strict(),
  resolve: z.object({ expectedVersion: version, resolution: requiredText }).strict(),
} as const;

type RiskItem = z.infer<typeof riskItemSchema>;
const severityLabels: Readonly<Record<RiskItem["severity"], string>> = { critical: "严重", high: "高", medium: "中", low: "低" };
const slaLabels: Readonly<Record<RiskItem["sla"], string>> = { "on-track": "SLA 正常", "due-soon": "即将到期", overdue: "已逾期" };

export interface RisksProps {
  readonly result: WorkspaceResult;
  readonly query: WorkspaceQueryValue;
  readonly activeTab: RiskTab;
  readonly selectedRiskId?: string;
  readonly capabilities: readonly string[];
  readonly online: boolean;
  readonly authenticated: boolean;
  readonly onTabChange: (tab: RiskTab) => void;
  readonly onSelectRisk: (riskId: string) => void;
  readonly onQueryChange: (query: WorkspaceQueryValue) => void;
  readonly onRefresh: () => void;
  readonly onExecute: (intent: WorkspaceCommand) => Promise<CommandReceipt>;
}

function WorkspaceAction({ command, schema, payload, targetId, capabilities, online, authenticated, onExecute, onRefresh }: {
  readonly command: WorkspaceOperation;
  readonly schema: z.ZodType<Record<string, unknown>>;
  readonly payload: Record<string, unknown>;
  readonly targetId?: string;
  readonly capabilities: readonly string[];
  readonly online: boolean;
  readonly authenticated: boolean;
  readonly onExecute: (intent: WorkspaceCommand) => Promise<CommandReceipt>;
  readonly onRefresh: () => void;
}) {
  const available = useMainOperationAvailability("risks");
  const parsed = schema.safeParse(payload);
  const operationBlocksFirst = !available(command.operation) || !online || !authenticated || !capabilities.includes(command.capability);
  if (!operationBlocksFirst && (!targetId || !parsed.success)) {
    const reasonId = `risks-${command.operation}-form-reason`;
    return <div><button type="button" disabled aria-describedby={reasonId}>{command.label}</button><p id={reasonId}>{targetId ? "请完成必填操作字段" : "请选择风险"}</p></div>;
  }
  return <CommandPanel workspace="risks" command={command} capabilities={capabilities} online={online} authenticated={authenticated} payload={parsed.success ? parsed.data : {}} {...(targetId ? { targetId } : {})} onExecute={onExecute} onConflictRefresh={onRefresh} />;
}

export function Risks({ result, query, activeTab, selectedRiskId, capabilities, online, authenticated, onTabChange, onSelectRisk, onQueryChange, onRefresh, onExecute }: RisksProps) {
  const definition = WORKSPACE_DEFINITIONS.risks;
  const tabs = definition.tabs as readonly { readonly id: RiskTab; readonly label: string }[];
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [expectedVersion, setExpectedVersion] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [mitigation, setMitigation] = useState("");
  const [escalationReason, setEscalationReason] = useState("");
  const [resolution, setResolution] = useState("");
  const mutationOnline = online && result.state !== "offline" && result.state !== "stale";
  const numericVersion = expectedVersion === "" ? Number.NaN : Number(expectedVersion);
  const selectTab = (index: number) => {
    const tab = tabs[index];
    if (!tab) return;
    onTabChange(tab.id);
    tabRefs.current[index]?.focus();
  };
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | undefined;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    if (next !== undefined) { event.preventDefault(); selectTab(next); }
  };
  const renderItem = (item: RiskItem) => (
    <table aria-label={item.risk}><tbody><tr aria-label={item.risk}>
      <td data-label="操作"><button type="button" aria-pressed={selectedRiskId === item.id} onClick={() => onSelectRisk(item.id)}>选择风险：{item.risk}</button></td>
      <td data-label="严重性"><span className="cell-inline-label">严重性：</span>{severityLabels[item.severity]}</td><td data-label="负责人"><span className="cell-inline-label">负责人：</span>{item.owner ?? "未分派"}</td><td data-label="状态"><span className="cell-inline-label">状态：</span>{item.status}</td>
      <td data-label="时限"><span className="cell-inline-label">时限：</span><time dateTime={item.deadline}>{new Date(item.deadline).toLocaleString("zh-CN")}</time></td><td data-label="SLA"><span className="cell-inline-label">SLA：</span>{slaLabels[item.sla]}</td><td data-label="版本"><span className="cell-inline-label">版本：</span>{item.version}</td>
    </tr></tbody></table>
  );
  const action = (operation: keyof typeof riskCommandPayloadSchemas, payload: Record<string, unknown>) => {
    const command = definition.commands.find((entry) => entry.operation === operation)!;
    return <WorkspaceAction key={operation} command={command} schema={riskCommandPayloadSchemas[operation]} payload={payload} {...(selectedRiskId ? { targetId: selectedRiskId } : {})} capabilities={capabilities} online={mutationOnline} authenticated={authenticated} onExecute={onExecute} onRefresh={onRefresh} />;
  };

  return (
    <section aria-labelledby="risks-title">
      <header><h1 id="risks-title">风险</h1></header>
      <div role="tablist" aria-label="风险视图">
        {tabs.map((tab, index) => <button ref={(node) => { tabRefs.current[index] = node; }} id={`risks-tab-${tab.id}`} type="button" role="tab" aria-selected={activeTab === tab.id} aria-controls="risks-panel" tabIndex={activeTab === tab.id ? 0 : -1} key={tab.id} onClick={() => onTabChange(tab.id)} onKeyDown={(event) => onTabKeyDown(event, index)}>{tab.label}</button>)}
      </div>
      <div id="risks-panel" role="tabpanel" aria-labelledby={`risks-tab-${activeTab}`}>
        <QueryToolbar definition={definition} value={query} onChange={onQueryChange} onRefresh={onRefresh} />
        <WorkspaceState result={result} itemSchema={riskItemSchema} onRetry={onRefresh} onRefresh={onRefresh} renderItem={renderItem} />
      </div>
      <section aria-label="风险操作">
        <fieldset disabled={!mutationOnline}><legend>风险版本</legend><label>预期风险版本<input type="number" min="0" value={expectedVersion} onChange={(event) => setExpectedVersion(event.currentTarget.value)} /></label></fieldset>
        {action("acknowledge", { expectedVersion: numericVersion })}
        <fieldset disabled={!mutationOnline}><legend>风险分派</legend><label>分派负责人<input value={assigneeId} onChange={(event) => setAssigneeId(event.currentTarget.value)} /></label></fieldset>
        {action("assign", { expectedVersion: numericVersion, assigneeId })}
        <fieldset disabled={!mutationOnline}><legend>风险缓解</legend><label>缓解措施<textarea value={mitigation} onChange={(event) => setMitigation(event.currentTarget.value)} /></label></fieldset>
        {action("mitigate", { expectedVersion: numericVersion, mitigation })}
        <fieldset disabled={!mutationOnline}><legend>风险升级</legend><label>升级原因<textarea value={escalationReason} onChange={(event) => setEscalationReason(event.currentTarget.value)} /></label></fieldset>
        {action("escalate", { expectedVersion: numericVersion, reason: escalationReason })}
        <fieldset disabled={!mutationOnline}><legend>风险解决</legend><label>解决说明<textarea value={resolution} onChange={(event) => setResolution(event.currentTarget.value)} /></label></fieldset>
        {action("resolve", { expectedVersion: numericVersion, resolution })}
      </section>
    </section>
  );
}
