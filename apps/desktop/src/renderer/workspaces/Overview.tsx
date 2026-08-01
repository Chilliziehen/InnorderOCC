import { SystemStatusSchema, type ServiceState, type SystemStatus } from "@innorder/contracts";
import { z } from "zod";

import type { WorkspaceResult } from "../../desktop-contract";
import { QueryToolbar, type WorkspaceQueryValue } from "../components/QueryToolbar";
import { WorkspaceState } from "../components/WorkspaceState";
import type { WorkspaceDefinition } from "./workspace-definitions";

const overviewItemSchema = z.object({
  item: z.string(),
  type: z.enum(["attention", "deadline", "risk", "process"]),
  status: z.string(),
  dueAt: z.iso.datetime({ offset: true }).optional(),
}).strict();

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
  { type: "process", label: "流程" },
] as const;

export interface OverviewProps {
  readonly definition: WorkspaceDefinition;
  readonly result: WorkspaceResult;
  readonly statuses: readonly unknown[];
  readonly query: WorkspaceQueryValue;
  readonly environment: string;
  readonly onQueryChange: (value: WorkspaceQueryValue) => void;
  readonly onRefresh: () => void;
  readonly onRetry?: () => void;
  readonly onConflictRefresh?: () => void;
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
    parsed.filter((entry) => entry.success && entry.data.type === type).length,
  ])) as Record<(typeof METRICS)[number]["type"], number>;
}

export function Overview({ definition, result, statuses, query, environment, onQueryChange, onRefresh, onRetry, onConflictRefresh }: OverviewProps) {
  const health = validatedStatuses(statuses);
  const counts = metricCounts(result);

  return (
    <main className="workspace workspace-overview" aria-labelledby="overview-title">
      <header>
        <h1 id="overview-title">运行总览</h1>
        <p>环境：{environment}</p>
      </header>
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
                <td>{status.service}</td>
                <td>{STATE_LABELS[status.state]}</td>
                <td>{status.version}</td>
                <td>{environment}</td>
                <td><time dateTime={status.checkedAt}>{new Date(status.checkedAt).toLocaleString("zh-CN")}</time></td>
              </tr>
            )) : <tr><td>--</td><td>--</td><td>--</td><td>{environment}</td><td>--</td></tr>}
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
    </main>
  );
}
