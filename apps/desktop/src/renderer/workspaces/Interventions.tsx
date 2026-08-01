import type { CommandReceipt, WorkspaceCommand, WorkspaceResult } from "../../desktop-contract";
import { z } from "zod";

import { CommandPanel } from "../components/CommandPanel";
import { QueryToolbar, type WorkspaceQueryValue } from "../components/QueryToolbar";
import { WorkspaceState } from "../components/WorkspaceState";
import { WORKSPACE_DEFINITIONS, type WorkspaceDefinition } from "./workspace-definitions";

export type InterventionTab = "evidence-reviews" | "exceptions" | "failed-automation" | "policy-blocks" | "ai-recommendations";

const interventionTabs: readonly { id: InterventionTab; label: string }[] = [
  { id: "evidence-reviews", label: "证据审核" },
  { id: "exceptions", label: "异常" },
  { id: "failed-automation", label: "自动化失败" },
  { id: "policy-blocks", label: "策略阻断" },
  { id: "ai-recommendations", label: "智能建议" },
];

const interventionDefinition: WorkspaceDefinition = {
  ...WORKSPACE_DEFINITIONS.interventions,
  tabs: interventionTabs,
  filters: [
    {
      key: "type",
      label: "介入类型",
      options: [
        { value: "review", label: "证据审核" },
        { value: "exception", label: "异常" },
        { value: "failed-automation", label: "自动化失败" },
        { value: "policy", label: "策略阻断" },
        { value: "recommendation", label: "智能建议" },
      ],
    },
    WORKSPACE_DEFINITIONS.interventions.filters[1]!,
  ],
};

const recommendationSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("cited"), summary: z.string(), citations: z.array(z.string()).min(1) }).strict(),
  z.object({ state: z.literal("stale"), summary: z.string(), asOf: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ state: z.literal("unavailable"), reason: z.string() }).strict(),
]);

export const interventionItemSchema = z.object({
  id: z.string().min(1),
  item: z.string().min(1),
  type: z.enum(["review", "exception", "failed-automation", "policy", "recommendation"]),
  owner: z.string().min(1).nullable(),
  status: z.string().min(1),
  recommendation: recommendationSchema.optional(),
}).strict();

type InterventionItem = z.infer<typeof interventionItemSchema>;

export interface InterventionsProps {
  readonly result: WorkspaceResult;
  readonly query: WorkspaceQueryValue;
  readonly activeTab: InterventionTab;
  readonly selectedItemId?: string;
  readonly capabilities: readonly string[];
  readonly online: boolean;
  readonly authenticated: boolean;
  readonly onTabChange: (tab: InterventionTab) => void;
  readonly onQueryChange: (query: WorkspaceQueryValue) => void;
  readonly onRefresh: () => void;
  readonly onExecute: (intent: WorkspaceCommand) => Promise<CommandReceipt>;
}

function Recommendation({ item }: { readonly item: InterventionItem }) {
  const recommendation = item.recommendation;
  if (!recommendation) return null;
  switch (recommendation.state) {
    case "cited":
      return <section aria-label="有引用的智能建议"><strong>有引用</strong><p>{recommendation.summary}</p><ul>{recommendation.citations.map((citation) => <li key={citation}><cite>{citation}</cite></li>)}</ul></section>;
    case "stale":
      return <section aria-label="过期的智能建议"><strong>建议已过期</strong><p>{recommendation.summary}</p><time dateTime={recommendation.asOf}>依据时间 {new Date(recommendation.asOf).toLocaleString("zh-CN")}</time></section>;
    case "unavailable":
      return <section aria-label="智能建议不可用"><strong>智能建议不可用</strong><p>{recommendation.reason}</p></section>;
  }
}

function InterventionRow(item: InterventionItem) {
  return (
    <article aria-label={item.item}>
      <h3>{item.item}</h3>
      <dl>
        <dt>类型</dt><dd>{item.type}</dd>
        <dt>处理人</dt><dd>{item.owner ?? "未分派"}</dd>
        <dt>状态</dt><dd>{item.status}</dd>
      </dl>
      <Recommendation item={item} />
    </article>
  );
}

export function Interventions({ result, query, activeTab, selectedItemId, capabilities, online, authenticated, onTabChange, onQueryChange, onRefresh, onExecute }: InterventionsProps) {
  const readOnly = !online || result.state === "offline" || result.state === "stale";
  return (
    <section aria-labelledby="interventions-title">
      <header><h1 id="interventions-title">人工介入中心</h1></header>
      <div role="tablist" aria-label="介入队列">
        {interventionTabs.map((tab) => <button type="button" role="tab" aria-selected={activeTab === tab.id} key={tab.id} onClick={() => onTabChange(tab.id)}>{tab.label}</button>)}
      </div>
      <QueryToolbar definition={interventionDefinition} value={query} disabled={readOnly} onChange={onQueryChange} onRefresh={onRefresh} />
      <WorkspaceState result={result} itemSchema={interventionItemSchema} onRetry={onRefresh} onRefresh={onRefresh} renderItem={InterventionRow} />
      <section aria-label="介入操作">
        {WORKSPACE_DEFINITIONS.interventions.commands.map((command) => (
          <CommandPanel
            key={command.operation}
            workspace="interventions"
            command={command}
            capabilities={capabilities}
            online={online && !readOnly}
            authenticated={authenticated}
            payload={{}}
            {...(selectedItemId ? { targetId: selectedItemId } : {})}
            onExecute={onExecute}
            onConflictRefresh={onRefresh}
          />
        ))}
      </section>
    </section>
  );
}
