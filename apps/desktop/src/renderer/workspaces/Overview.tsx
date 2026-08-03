import { SystemStatusSchema, type ServiceState, type SystemStatus } from "@innorder/contracts";
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { z } from "zod";

import type { WorkspaceResult } from "../../desktop-contract";
import { QueryToolbar, type WorkspaceQueryValue } from "../components/QueryToolbar";
import { WorkspaceState } from "../components/WorkspaceState";
import type { WorkspaceDefinition } from "./workspace-definitions";

const overviewItemBase = {
  item: z.string(),
  dueAt: z.iso.datetime({ offset: true }).optional(),
};
const overviewItemSchema = z.discriminatedUnion("type", [
  z.object({ ...overviewItemBase, type: z.literal("attention"), status: z.string() }).strict(),
  z.object({ ...overviewItemBase, type: z.literal("deadline"), status: z.string() }).strict(),
  z.object({ ...overviewItemBase, type: z.literal("risk"), status: z.string() }).strict(),
  z.object({
    ...overviewItemBase,
    type: z.literal("process"),
    status: z.enum(["RUNNING", "SUSPENDED", "COMPLETED", "CANCELLED", "FAILED"]),
  }).strict(),
]);

const STATE_LABELS: Record<ServiceState, string> = {
  READY: "就绪",
  DEGRADED: "降级",
  UNREACHABLE: "不可达",
  CHECKING: "检查中",
};

const METRICS = [
  { type: "attention", label: "关注事项" },
  { type: "deadline", label: "时限" },
  { type: "risk", label: "风险" },
  { type: "process", label: "进行中流程" },
] as const;

export interface OverviewProps {
  readonly definition: WorkspaceDefinition;
  readonly result: WorkspaceResult;
  readonly statuses: readonly unknown[];
  readonly query: WorkspaceQueryValue;
  readonly activeTab: string;
  readonly environment: string;
  readonly onTabChange: (tabId: string) => void;
  readonly onQueryChange: (value: WorkspaceQueryValue) => void;
  readonly onRefresh: () => void;
  readonly onRetry?: () => void;
  readonly onConflictRefresh?: () => void;
}

function WorkspaceTabs({ definition, activeTab, label, onTabChange, children }: {
  readonly definition: WorkspaceDefinition;
  readonly activeTab: string;
  readonly label: string;
  readonly onTabChange: (tabId: string) => void;
  readonly children: ReactNode;
}) {
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedTab = definition.tabs.some(({ id }) => id === activeTab)
    ? activeTab
    : definition.tabs[0]?.id;
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % definition.tabs.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + definition.tabs.length) % definition.tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = definition.tabs.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    tabs.current[nextIndex]?.focus();
    const nextTab = definition.tabs[nextIndex];
    if (nextTab) onTabChange(nextTab.id);
  };

  return (
    <>
      <div role="tablist" aria-label={label}>
        {definition.tabs.map((tab, index) => {
          const selected = tab.id === selectedTab;
          return <button
            type="button"
            role="tab"
            id={`${definition.id}-tab-${tab.id}`}
            aria-controls={`${definition.id}-panel`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            ref={(element) => { tabs.current[index] = element; }}
            onClick={() => onTabChange(tab.id)}
            onKeyDown={(event) => moveFocus(event, index)}
            key={tab.id}
          >{tab.label}</button>;
        })}
      </div>
      {selectedTab ? <div role="tabpanel" id={`${definition.id}-panel`} aria-labelledby={`${definition.id}-tab-${selectedTab}`} tabIndex={0}>{children}</div> : null}
    </>
  );
}

function validatedStatuses(statuses: readonly unknown[]): SystemStatus[] {
  return statuses.flatMap((status) => {
    const parsed = SystemStatusSchema.safeParse(status);
    return parsed.success ? [parsed.data] : [];
  });
}

function metricCounts(result: WorkspaceResult): Readonly<Record<(typeof METRICS)[number]["type"], number>> | undefined {
  if (!("items" in result)) return undefined;
  const parsed = result.items.map((item) => overviewItemSchema.safeParse(item));
  if (parsed.some((entry) => !entry.success)) return undefined;
  return Object.fromEntries(METRICS.map(({ type }) => [
    type,
    parsed.filter((entry) => entry.success && entry.data.type === type && (
      type !== "process" || entry.data.status === "RUNNING"
    )).length,
  ])) as Record<(typeof METRICS)[number]["type"], number>;
}

export function Overview({ definition, result, statuses, query, activeTab, environment, onTabChange, onQueryChange, onRefresh, onRetry, onConflictRefresh }: OverviewProps) {
  const health = validatedStatuses(statuses);
  const counts = metricCounts(result);

  return (
    <section className="workspace-overview" aria-labelledby="overview-title">
      <header>
        <h1 id="overview-title">运行总览</h1>
        <p>环境：{environment}</p>
      </header>
      <WorkspaceTabs definition={definition} activeTab={activeTab} label="运行总览视图" onTabChange={onTabChange}>
        <QueryToolbar definition={definition} value={query} disabled={result.state === "loading"} onChange={onQueryChange} onRefresh={onRefresh} />

        <section aria-label="运行指标">
          {METRICS.map(({ type, label }) => (
            <article key={type}>
              <h2>{label}</h2>
              <strong>{counts?.[type] ?? "--"}</strong>
              <span>{counts ? "已验证数据" : "不可用"}</span>
            </article>
          ))}
        </section>

        <section aria-labelledby="overview-health-title">
          <h2 id="overview-health-title">服务健康</h2>
          <table aria-label="服务健康">
            <thead><tr><th scope="col">服务</th><th scope="col">状态</th><th scope="col">版本</th><th scope="col">环境</th><th scope="col">新鲜度</th></tr></thead>
            <tbody>
              {health.length > 0 ? health.map((status) => (
                <tr key={status.service}>
                  <td data-label="服务">{status.service}</td>
                  <td data-label="状态">{STATE_LABELS[status.state]}</td>
                  <td data-label="版本">{status.version}</td>
                  <td data-label="环境">{environment}</td>
                  <td data-label="新鲜度"><time dateTime={status.checkedAt}>{new Date(status.checkedAt).toLocaleString("zh-CN")}</time></td>
                </tr>
              )) : <tr><td data-label="服务">--</td><td data-label="状态">--</td><td data-label="版本">--</td><td data-label="环境">{environment}</td><td data-label="新鲜度">--</td></tr>}
            </tbody>
          </table>
        </section>

        <WorkspaceState
          result={result}
          itemSchema={overviewItemSchema}
          columns={definition.columns}
          onRetry={onRetry ?? onRefresh}
          onRefresh={onConflictRefresh ?? onRefresh}
        />
      </WorkspaceTabs>
    </section>
  );
}
