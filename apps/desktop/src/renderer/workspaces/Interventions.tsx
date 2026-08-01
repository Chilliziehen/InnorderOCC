import { useRef, useState, type KeyboardEvent } from "react";
import { z } from "zod";

import type { CommandReceipt, WorkspaceCommand, WorkspaceResult } from "../../desktop-contract";
import { CommandPanel } from "../components/CommandPanel";
import { QueryToolbar, type WorkspaceQueryValue } from "../components/QueryToolbar";
import { WorkspaceState } from "../components/WorkspaceState";
import { WORKSPACE_DEFINITIONS, type WorkspaceOperation } from "./workspace-definitions";

export type InterventionTab = "reviews" | "exceptions" | "failed-automation" | "policy" | "ai";

const requiredText = z.string().trim().min(1);
const version = z.number().int().min(0);
const recommendationSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("cited"), summary: requiredText, citations: z.array(requiredText).min(1) }).strict(),
  z.object({ state: z.literal("uncited-rejected"), summary: requiredText, reason: requiredText }).strict(),
  z.object({ state: z.literal("stale"), summary: requiredText, asOf: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ state: z.literal("disabled"), reason: requiredText }).strict(),
  z.object({ state: z.literal("unavailable"), reason: requiredText }).strict(),
]);

export const interventionItemSchema = z.object({
  id: requiredText,
  item: requiredText,
  type: z.enum(["review", "exception", "failed-automation", "policy", "recommendation"]),
  owner: requiredText.nullable(),
  status: requiredText,
  version,
  evidenceVersion: version.optional(),
  recommendation: recommendationSchema.optional(),
}).strict().superRefine((item, context) => {
  if (item.type === "recommendation" && !item.recommendation) {
    context.addIssue({ code: "custom", path: ["recommendation"], message: "Recommendation state is required" });
  }
  if (item.type === "review" && item.evidenceVersion === undefined) {
    context.addIssue({ code: "custom", path: ["evidenceVersion"], message: "Evidence version is required" });
  }
});

export const interventionCommandPayloadSchemas = {
  accept: z.object({ evidenceVersion: version, expectedVersion: version }).strict(),
  conditional: z.object({ evidenceVersion: version, expectedVersion: version, followUp: requiredText, dueAt: requiredText }).strict(),
  reject: z.object({ evidenceVersion: version, expectedVersion: version }).strict(),
  return: z.object({ expectedVersion: version, reason: requiredText }).strict(),
} as const;

type InterventionItem = z.infer<typeof interventionItemSchema>;

export function reviewTargetGateReason({ operationAvailable, online, authenticated, capable, selectedType }: {
  readonly operationAvailable: boolean;
  readonly online: boolean;
  readonly authenticated: boolean;
  readonly capable: boolean;
  readonly selectedType?: InterventionItem["type"];
}): string | undefined {
  if (!operationAvailable || !authenticated || !online || !capable || selectedType === "review") return undefined;
  return selectedType ? "仅证据审核事项可执行审核操作" : "请选择证据审核事项";
}

export interface InterventionsProps {
  readonly result: WorkspaceResult;
  readonly query: WorkspaceQueryValue;
  readonly activeTab: InterventionTab;
  readonly selectedItemId?: string;
  readonly capabilities: readonly string[];
  readonly online: boolean;
  readonly authenticated: boolean;
  readonly onTabChange: (tab: InterventionTab) => void;
  readonly onSelectItem: (itemId: string) => void;
  readonly onQueryChange: (query: WorkspaceQueryValue) => void;
  readonly onRefresh: () => void;
  readonly onExecute: (intent: WorkspaceCommand) => Promise<CommandReceipt>;
}

function Recommendation({ recommendation }: { readonly recommendation: NonNullable<InterventionItem["recommendation"]> }) {
  switch (recommendation.state) {
    case "cited":
      return <section aria-label="有引用的智能建议"><strong>建议已生成</strong><p>状态：有引用</p><p>{recommendation.summary}</p><ul>{recommendation.citations.map((citation) => <li key={citation}><cite>{citation}</cite></li>)}</ul></section>;
    case "uncited-rejected":
      return <section aria-label="无引用建议已拒绝"><strong>建议未采用</strong><p>{recommendation.summary}</p><p>{recommendation.reason}</p></section>;
    case "stale":
      return <section aria-label="过期的智能建议"><strong>建议已生成</strong><p>状态：已过期</p><p>{recommendation.summary}</p><time dateTime={recommendation.asOf}>依据时间 {new Date(recommendation.asOf).toLocaleString("zh-CN")}</time></section>;
    case "disabled":
      return <section aria-label="智能建议已禁用"><strong>智能建议已禁用</strong><p>{recommendation.reason}</p></section>;
    case "unavailable":
      return <section aria-label="智能建议不可用"><strong>智能建议不可用</strong><p>{recommendation.reason}</p></section>;
  }
}

function WorkspaceAction({ command, schema, payload, targetId, targetGateReason, capabilities, online, authenticated, onExecute, onRefresh }: {
  readonly command: WorkspaceOperation;
  readonly schema: z.ZodType<Record<string, unknown>>;
  readonly payload: Record<string, unknown>;
  readonly targetId?: string;
  readonly targetGateReason?: string;
  readonly capabilities: readonly string[];
  readonly online: boolean;
  readonly authenticated: boolean;
  readonly onExecute: (intent: WorkspaceCommand) => Promise<CommandReceipt>;
  readonly onRefresh: () => void;
}) {
  const parsed = schema.safeParse(payload);
  const operationBlocksFirst = command.availability.state === "unavailable" || !online || !authenticated || !capabilities.includes(command.capability);
  if (!operationBlocksFirst && targetGateReason) {
    const reasonId = `interventions-${command.operation}-review-target-reason`;
    return <div><button type="button" disabled aria-describedby={reasonId}>{command.label}</button><p id={reasonId}>{targetGateReason}</p></div>;
  }
  if (!operationBlocksFirst && (!targetId || !parsed.success)) {
    const reasonId = `interventions-${command.operation}-form-reason`;
    return <div><button type="button" disabled aria-describedby={reasonId}>{command.label}</button><p id={reasonId}>{targetId ? "请完成必填操作字段" : "请选择介入事项"}</p></div>;
  }
  return <CommandPanel workspace="interventions" command={command} capabilities={capabilities} online={online} authenticated={authenticated} payload={parsed.success ? parsed.data : {}} {...(targetId ? { targetId } : {})} onExecute={onExecute} onConflictRefresh={onRefresh} />;
}

export function Interventions({ result, query, activeTab, selectedItemId, capabilities, online, authenticated, onTabChange, onSelectItem, onQueryChange, onRefresh, onExecute }: InterventionsProps) {
  const definition = WORKSPACE_DEFINITIONS.interventions;
  const tabs = definition.tabs as readonly { readonly id: InterventionTab; readonly label: string }[];
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [followUp, setFollowUp] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [returnReason, setReturnReason] = useState("");
  const mutationOnline = online && result.state !== "offline" && result.state !== "stale";
  const selectedItem = result.state === "ready" || result.state === "stale" || result.state === "offline"
    ? result.items.map((item) => interventionItemSchema.safeParse(item)).find((entry) => entry.success && entry.data.id === selectedItemId)?.data
    : undefined;
  const selectedReview = selectedItem?.type === "review" && selectedItem.evidenceVersion !== undefined ? selectedItem : undefined;
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
  const renderItem = (item: InterventionItem) => (
    <article aria-label={item.item}>
      <button type="button" aria-pressed={selectedItemId === item.id} onClick={() => onSelectItem(item.id)}>选择介入事项：{item.item}</button>
      <dl><dt>类型</dt><dd>{item.type}</dd><dt>处理人</dt><dd>{item.owner ?? "未分派"}</dd><dt>状态</dt><dd>{item.status}</dd><dt>版本</dt><dd>{item.version}</dd></dl>
      {item.recommendation ? <Recommendation recommendation={item.recommendation} /> : null}
    </article>
  );
  const action = (operation: keyof typeof interventionCommandPayloadSchemas, payload: Record<string, unknown>) => {
    const command = definition.commands.find((entry) => entry.operation === operation)!;
    const targetGateReason = reviewTargetGateReason({
      operationAvailable: command.availability.state === "available",
      online: mutationOnline,
      authenticated,
      capable: capabilities.includes(command.capability),
      ...(selectedItem ? { selectedType: selectedItem.type } : {}),
    });
    return <WorkspaceAction key={operation} command={command} schema={interventionCommandPayloadSchemas[operation]} payload={payload} {...(selectedReview ? { targetId: selectedReview.id } : {})} {...(targetGateReason ? { targetGateReason } : {})} capabilities={capabilities} online={mutationOnline} authenticated={authenticated} onExecute={onExecute} onRefresh={onRefresh} />;
  };
  const reviewPayload = {
    evidenceVersion: selectedReview?.evidenceVersion ?? Number.NaN,
    expectedVersion: selectedReview?.version ?? Number.NaN,
  };

  return (
    <section aria-labelledby="interventions-title">
      <header><h1 id="interventions-title">人工介入中心</h1></header>
      <div role="tablist" aria-label="介入队列">
        {tabs.map((tab, index) => <button ref={(node) => { tabRefs.current[index] = node; }} id={`interventions-tab-${tab.id}`} type="button" role="tab" aria-selected={activeTab === tab.id} aria-controls="interventions-panel" tabIndex={activeTab === tab.id ? 0 : -1} key={tab.id} onClick={() => onTabChange(tab.id)} onKeyDown={(event) => onTabKeyDown(event, index)}>{tab.label}</button>)}
      </div>
      <div id="interventions-panel" role="tabpanel" aria-labelledby={`interventions-tab-${activeTab}`}>
        <QueryToolbar definition={definition} value={query} onChange={onQueryChange} onRefresh={onRefresh} />
        <WorkspaceState result={result} itemSchema={interventionItemSchema} onRetry={onRefresh} onRefresh={onRefresh} renderItem={renderItem} />
      </div>
      <section aria-label="介入操作">
        <section aria-label="证据审核版本"><h2>证据审核版本</h2>{selectedReview ? <><p>证据版本：{selectedReview.evidenceVersion}</p><p>预期版本：{selectedReview.version}</p></> : <p>版本由选中的证据审核事项提供</p>}</section>
        {action("accept", reviewPayload)}
        <fieldset disabled={!mutationOnline}><legend>有条件接受要求</legend><label>有条件接受后续要求<textarea value={followUp} onChange={(event) => setFollowUp(event.currentTarget.value)} /></label><label>有条件接受到期日<input type="date" value={dueAt} onChange={(event) => setDueAt(event.currentTarget.value)} /></label></fieldset>
        {action("conditional", { ...reviewPayload, followUp, dueAt })}
        {action("reject", reviewPayload)}
        <fieldset disabled={!mutationOnline}><legend>退回要求</legend><label>退回原因<textarea value={returnReason} onChange={(event) => setReturnReason(event.currentTarget.value)} /></label></fieldset>
        {action("return", { expectedVersion: selectedReview?.version ?? Number.NaN, reason: returnReason })}
      </section>
    </section>
  );
}
