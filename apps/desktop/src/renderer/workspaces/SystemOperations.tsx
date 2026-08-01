import { SystemStatusSchema, type ServiceState, type SystemStatus } from "@innorder/contracts";
import { z } from "zod";

import type { WorkspaceResult } from "../../desktop-contract";
import { QueryToolbar, type WorkspaceQueryValue } from "../components/QueryToolbar";
import { WorkspaceState } from "../components/WorkspaceState";
import type { WorkspaceDefinition } from "./workspace-definitions";

const systemItemSchema = z.object({
  service: z.string(),
  version: z.string(),
  state: z.enum(["READY", "DEGRADED", "UNREACHABLE", "CHECKING"]),
  freshness: z.iso.datetime({ offset: true }),
}).strict();

const STATE_LABELS: Record<ServiceState, string> = {
  READY: "就绪",
  DEGRADED: "降级",
  UNREACHABLE: "不可达",
  CHECKING: "检查中",
};

export interface SystemOperationsProps {
  readonly definition: WorkspaceDefinition;
  readonly result: WorkspaceResult;
  readonly statuses: readonly unknown[];
  readonly query: WorkspaceQueryValue;
  readonly environment: string;
  readonly configurationFreshness?: string;
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

export function SystemOperations({ definition, result, statuses, query, environment, configurationFreshness, onQueryChange, onRefresh, onRetry, onConflictRefresh }: SystemOperationsProps) {
  const validated = validatedStatuses(statuses);

  return (
    <main className="workspace workspace-system" aria-labelledby="system-title">
      <header>
        <h1 id="system-title">系统运行</h1>
        <dl>
          <div><dt>环境</dt><dd>{environment}</dd></div>
          <div><dt>配置新鲜度</dt><dd>{configurationFreshness ? <time dateTime={configurationFreshness}>{new Date(configurationFreshness).toLocaleString("zh-CN")}</time> : "--"}</dd></div>
        </dl>
      </header>
      <QueryToolbar definition={definition} value={query} disabled={result.state === "loading"} onChange={onQueryChange} onRefresh={onRefresh} />

      <section aria-labelledby="services-components-title">
        <h2 id="services-components-title">服务与组件</h2>
        <table aria-label="服务与组件状态">
          <thead><tr><th scope="col">类型</th><th scope="col">名称</th><th scope="col">状态</th><th scope="col">版本</th><th scope="col">环境</th><th scope="col">新鲜度</th><th scope="col">详情</th></tr></thead>
          <tbody>
            {validated.length > 0 ? validated.flatMap((status) => [
              <tr key={`service-${status.service}`}>
                <td>服务</td><td>{status.service}</td><td>{STATE_LABELS[status.state]}</td><td>{status.version}</td><td>{environment}</td><td><time dateTime={status.checkedAt}>{new Date(status.checkedAt).toLocaleString("zh-CN")}</time></td><td>--</td>
              </tr>,
              ...status.components.map((component) => (
                <tr key={`${status.service}-${component.id}`}>
                  <td>组件</td><td>{component.label}</td><td>{STATE_LABELS[component.state]}</td><td>--</td><td>{environment}</td><td><time dateTime={component.checkedAt}>{new Date(component.checkedAt).toLocaleString("zh-CN")}</time></td><td>{component.detail ?? "--"}</td>
                </tr>
              )),
            ]) : <tr><td>服务</td><td>--</td><td>--</td><td>--</td><td>{environment}</td><td>--</td><td>--</td></tr>}
          </tbody>
        </table>
      </section>

      <section role="region" aria-label="Outbox 状态"><h2>Outbox</h2><strong>不可用</strong><p>Outbox 运行摘要 API 合同尚未集成。</p></section>
      <section role="region" aria-label="通知投递状态"><h2>通知投递</h2><strong>不可用</strong><p>通知投递摘要 API 合同尚未集成。</p></section>

      <WorkspaceState
        result={result}
        itemSchema={systemItemSchema}
        columns={definition.columns}
        onRetry={onRetry ?? onRefresh}
        onRefresh={onConflictRefresh ?? onRefresh}
      />
    </main>
  );
}
