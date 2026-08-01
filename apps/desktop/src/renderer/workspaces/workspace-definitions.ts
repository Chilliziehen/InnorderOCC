import {
  WORKSPACE_MANIFEST,
  type AvailableOperation,
  type OperationAvailability,
  type UnavailableOperation,
  type WorkspaceId,
  type WorkspaceOperation,
} from "../workspace-manifest";

export type {
  AvailableOperation,
  OperationAvailability,
  UnavailableOperation,
  WorkspaceId,
  WorkspaceOperation,
} from "../workspace-manifest";

export interface FilterDescriptor {
  readonly key: string;
  readonly label: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

export interface WorkspaceDefinition {
  readonly id: WorkspaceId;
  readonly apiGroups: readonly string[];
  readonly tabs: readonly { readonly id: string; readonly label: string }[];
  readonly filters: readonly FilterDescriptor[];
  readonly sortOptions: readonly { readonly value: string; readonly label: string }[];
  readonly columns: readonly { readonly key: string; readonly label: string }[];
  readonly query: WorkspaceOperation;
  readonly commands: readonly WorkspaceOperation[];
}

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

const option = (value: string, label: string) => ({ value, label });
const filter = (key: string, label: string, options: readonly { value: string; label: string }[]): FilterDescriptor => ({ key, label, options });
type WorkspaceUiDefinition = Pick<WorkspaceDefinition, "tabs" | "filters" | "sortOptions" | "columns">;

const uiDefinitions: Record<WorkspaceId, WorkspaceUiDefinition> = {
  overview: {
    tabs: [{ id: "attention", label: "关注事项" }, { id: "deadlines", label: "时限" }, { id: "risks", label: "风险" }, { id: "health", label: "服务健康" }],
    filters: [filter("severity", "严重性", [option("high", "高"), option("medium", "中"), option("low", "低")])],
    sortOptions: [option("priority-desc", "优先级"), option("due-asc", "最早到期")],
    columns: [{ key: "item", label: "事项" }, { key: "type", label: "类型" }, { key: "status", label: "状态" }, { key: "dueAt", label: "时限" }],
  },
  "my-work": {
    tabs: ["available", "claimed", "blocked", "pending-review", "returned", "completed"].map((id) => ({ id, label: ({ available: "可领取", claimed: "已领取", blocked: "已阻断", "pending-review": "待审核", returned: "已退回", completed: "已完成" } as Record<string, string>)[id]! })),
    filters: [filter("state", "状态", [option("available", "可领取"), option("claimed", "已领取"), option("blocked", "已阻断")])],
    sortOptions: [option("due-asc", "最早到期"), option("updated-desc", "最近更新")],
    columns: [{ key: "task", label: "任务" }, { key: "process", label: "流程" }, { key: "state", label: "状态" }, { key: "dueAt", label: "时限" }],
  },
  processes: {
    tabs: [{ id: "cohorts", label: "群组" }, { id: "processes", label: "流程" }, { id: "participants", label: "参与者" }, { id: "tasks", label: "任务" }, { id: "timeline", label: "时间线" }],
    filters: [filter("status", "状态", [option("active", "进行中"), option("suspended", "已暂停"), option("completed", "已完成")]), filter("participant", "参与者", []), filter("timeline", "时间范围", [option("today", "今天"), option("week", "本周")])],
    sortOptions: [option("updated-desc", "最近更新"), option("started-desc", "最近开始")],
    columns: [{ key: "process", label: "流程" }, { key: "cohort", label: "群组" }, { key: "owner", label: "负责人" }, { key: "status", label: "状态" }],
  },
  interventions: {
    tabs: [{ id: "reviews", label: "证据审核" }, { id: "exceptions", label: "异常" }, { id: "policy", label: "策略阻断" }, { id: "ai", label: "智能建议" }],
    filters: [filter("type", "介入类型", [option("review", "审核"), option("exception", "异常"), option("policy", "策略")]), filter("status", "状态", [option("open", "待处理"), option("resolved", "已处理")])],
    sortOptions: [option("created-desc", "最新进入"), option("priority-desc", "优先级")],
    columns: [{ key: "item", label: "介入事项" }, { key: "type", label: "类型" }, { key: "owner", label: "处理人" }, { key: "status", label: "状态" }],
  },
  risks: {
    tabs: [{ id: "open", label: "未解决" }, { id: "mine", label: "我的风险" }, { id: "resolved", label: "已解决" }],
    filters: [filter("severity", "严重性", [option("critical", "严重"), option("high", "高"), option("medium", "中"), option("low", "低")]), filter("sla", "SLA", [option("overdue", "已逾期"), option("due-soon", "即将到期")]), filter("owner", "负责人", []), filter("status", "状态", [option("open", "未解决"), option("resolved", "已解决")])],
    sortOptions: [option("severity-desc", "严重性"), option("updated-desc", "最近更新"), option("sla-asc", "SLA 时限")],
    columns: [{ key: "risk", label: "风险" }, { key: "severity", label: "严重性" }, { key: "owner", label: "负责人" }, { key: "status", label: "状态" }],
  },
  resources: {
    tabs: [{ id: "inventory", label: "资源库存" }, { id: "reservations", label: "预留" }, { id: "conflicts", label: "冲突" }],
    filters: [filter("type", "资源类型", []), filter("availability", "可用性", [option("available", "可用"), option("reserved", "已预留")]), filter("conflict", "冲突", [option("true", "存在冲突"), option("false", "无冲突")])],
    sortOptions: [option("name-asc", "名称"), option("availability-desc", "可用量")],
    columns: [{ key: "resource", label: "资源" }, { key: "type", label: "类型" }, { key: "availability", label: "可用量" }, { key: "reservation", label: "预留状态" }],
  },
  "domain-design": {
    tabs: [{ id: "drafts", label: "草稿" }, { id: "versions", label: "版本" }, { id: "validation", label: "校验" }, { id: "releases", label: "发布" }],
    filters: [filter("status", "状态", [option("draft", "草稿"), option("approved", "已批准"), option("published", "已发布")]), filter("validation", "校验结果", [option("passed", "通过"), option("failed", "失败")])],
    sortOptions: [option("updated-desc", "最近更新"), option("name-asc", "名称")],
    columns: [{ key: "package", label: "领域包" }, { key: "version", label: "版本" }, { key: "validation", label: "校验" }, { key: "status", label: "状态" }],
  },
  administration: {
    tabs: [{ id: "people", label: "人员" }, { id: "relationships", label: "关系" }, { id: "roles", label: "角色" }, { id: "policies", label: "策略发布" }, { id: "providers", label: "智能服务" }, { id: "knowledge", label: "知识" }, { id: "audit", label: "审计" }],
    filters: [filter("status", "状态", [option("active", "启用"), option("disabled", "停用")]), filter("type", "类型", [])],
    sortOptions: [option("updated-desc", "最近更新"), option("name-asc", "名称")],
    columns: [{ key: "subject", label: "对象" }, { key: "type", label: "类型" }, { key: "status", label: "状态" }, { key: "updatedAt", label: "更新时间" }],
  },
  system: {
    tabs: [{ id: "services", label: "服务" }, { id: "dependencies", label: "依赖" }, { id: "delivery", label: "事件投递" }],
    filters: [filter("state", "运行状态", [option("READY", "就绪"), option("DEGRADED", "降级"), option("UNREACHABLE", "不可达")])],
    sortOptions: [option("service-asc", "服务名称"), option("state-asc", "运行状态")],
    columns: [{ key: "service", label: "服务" }, { key: "version", label: "版本" }, { key: "state", label: "状态" }, { key: "freshness", label: "新鲜度" }],
  },
  settings: {
    tabs: [{ id: "profile", label: "服务器配置" }, { id: "trust", label: "TLS 信任" }, { id: "preferences", label: "偏好" }, { id: "session", label: "会话" }],
    filters: [],
    sortOptions: [option("name-asc", "配置名称")],
    columns: [{ key: "profile", label: "配置" }, { key: "environment", label: "环境" }, { key: "origin", label: "服务器" }, { key: "trust", label: "信任状态" }],
  },
};

const definitions = Object.fromEntries(WORKSPACE_MANIFEST.map((workspace) => [workspace.id, {
  id: workspace.id,
  apiGroups: workspace.resourceGroups,
  ...uiDefinitions[workspace.id],
  query: workspace.query,
  commands: workspace.commands,
}])) as Record<WorkspaceId, WorkspaceDefinition>;

export const WORKSPACE_DEFINITIONS = deepFreeze(definitions);

export function commandFor(workspace: WorkspaceId | WorkspaceDefinition, operationName: string): WorkspaceOperation | undefined {
  const canonical = typeof workspace === "string" ? WORKSPACE_DEFINITIONS[workspace] : WORKSPACE_DEFINITIONS[workspace.id];
  if (!canonical || (typeof workspace !== "string" && canonical !== workspace)) return undefined;
  return canonical.commands.find(({ operation: name }) => name === operationName);
}
