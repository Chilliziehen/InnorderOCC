export type WorkspaceId =
  | "overview"
  | "my-work"
  | "processes"
  | "interventions"
  | "risks"
  | "resources"
  | "domain-design"
  | "administration"
  | "system"
  | "settings";

export interface UnavailableOperation {
  readonly state: "unavailable";
  readonly reason: "UNAVAILABLE_CONTRACT";
  readonly resourceGroups: readonly string[];
  readonly message: string;
}

export interface AvailableOperation {
  readonly state: "available";
}

export type OperationAvailability = AvailableOperation | UnavailableOperation;

export interface WorkspaceOperation {
  readonly operation: string;
  readonly label: string;
  readonly capability: string;
  readonly availability: OperationAvailability;
}

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

const available = (): AvailableOperation => ({ state: "available" });
const unavailable = (resourceGroups: readonly string[], message: string): UnavailableOperation => ({
  state: "unavailable",
  reason: "UNAVAILABLE_CONTRACT",
  resourceGroups,
  message,
});
const option = (value: string, label: string) => ({ value, label });
const filter = (key: string, label: string, options: readonly { value: string; label: string }[]): FilterDescriptor => ({ key, label, options });
const operation = (name: string, label: string, capability: string, groups: readonly string[], message: string): WorkspaceOperation => ({
  operation: name,
  label,
  capability,
  availability: unavailable(groups, message),
});

const definitions: Record<WorkspaceId, WorkspaceDefinition> = {
  overview: {
    id: "overview",
    apiGroups: ["/me", "/tasks", "/processes", "/risks", "/system"],
    tabs: [{ id: "attention", label: "关注事项" }, { id: "deadlines", label: "时限" }, { id: "risks", label: "风险" }, { id: "health", label: "服务健康" }],
    filters: [filter("severity", "严重性", [option("high", "高"), option("medium", "中"), option("low", "低")])],
    sortOptions: [option("priority-desc", "优先级"), option("due-asc", "最早到期")],
    columns: [{ key: "item", label: "事项" }, { key: "type", label: "类型" }, { key: "status", label: "状态" }, { key: "dueAt", label: "时限" }],
    query: operation("overview.query", "查询运行总览", "overview.query", ["/me", "/tasks", "/processes", "/risks"], "总览业务 API 合同尚未集成"),
    commands: [],
  },
  "my-work": {
    id: "my-work",
    apiGroups: ["/tasks", "/evidence", "/reservations", "/recommendations"],
    tabs: ["available", "claimed", "blocked", "pending-review", "returned", "completed"].map((id) => ({ id, label: ({ available: "可领取", claimed: "已领取", blocked: "已阻断", "pending-review": "待审核", returned: "已退回", completed: "已完成" } as Record<string, string>)[id]! })),
    filters: [filter("state", "状态", [option("available", "可领取"), option("claimed", "已领取"), option("blocked", "已阻断")])],
    sortOptions: [option("due-asc", "最早到期"), option("updated-desc", "最近更新")],
    columns: [{ key: "task", label: "任务" }, { key: "process", label: "流程" }, { key: "state", label: "状态" }, { key: "dueAt", label: "时限" }],
    query: operation("tasks.query", "查询我的工作", "tasks.query", ["/tasks"], "任务 API 合同尚未集成"),
    commands: [
      operation("claim", "领取任务", "tasks.claim", ["/tasks"], "任务领取 API 合同尚未集成"),
      operation("submitEvidence", "提交证据", "evidence.submit", ["/evidence"], "证据提交 API 合同尚未集成"),
      operation("reserve", "预留资源", "reservations.create", ["/reservations"], "资源预留 API 合同尚未集成"),
      operation("guidance", "请求智能建议", "recommendations.request", ["/recommendations"], "智能建议 API 合同尚未集成"),
    ],
  },
  processes: {
    id: "processes",
    apiGroups: ["/cohorts", "/processes", "/tasks"],
    tabs: [{ id: "cohorts", label: "群组" }, { id: "processes", label: "流程" }, { id: "participants", label: "参与者" }, { id: "tasks", label: "任务" }, { id: "timeline", label: "时间线" }],
    filters: [filter("status", "状态", [option("active", "进行中"), option("suspended", "已暂停"), option("completed", "已完成")]), filter("participant", "参与者", []), filter("timeline", "时间范围", [option("today", "今天"), option("week", "本周")])],
    sortOptions: [option("updated-desc", "最近更新"), option("started-desc", "最近开始")],
    columns: [{ key: "process", label: "流程" }, { key: "cohort", label: "群组" }, { key: "owner", label: "负责人" }, { key: "status", label: "状态" }],
    query: operation("processes.query", "查询流程", "processes.query", ["/cohorts", "/processes", "/tasks"], "流程 API 合同尚未集成"),
    commands: [operation("create", "创建群组", "cohorts.create", ["/cohorts"], "群组创建 API 合同尚未集成"), operation("start", "启动流程", "processes.start", ["/processes"], "流程启动 API 合同尚未集成"), operation("suspend", "暂停流程", "processes.suspend", ["/processes"], "流程暂停 API 合同尚未集成"), operation("cancel", "取消流程", "processes.cancel", ["/processes"], "流程取消 API 合同尚未集成")],
  },
  interventions: {
    id: "interventions",
    apiGroups: ["/evidence", "/risks", "/recommendations", "/audit"],
    tabs: [{ id: "reviews", label: "证据审核" }, { id: "exceptions", label: "异常" }, { id: "policy", label: "策略阻断" }, { id: "ai", label: "智能建议" }],
    filters: [filter("type", "介入类型", [option("review", "审核"), option("exception", "异常"), option("policy", "策略")]), filter("status", "状态", [option("open", "待处理"), option("resolved", "已处理")])],
    sortOptions: [option("created-desc", "最新进入"), option("priority-desc", "优先级")],
    columns: [{ key: "item", label: "介入事项" }, { key: "type", label: "类型" }, { key: "owner", label: "处理人" }, { key: "status", label: "状态" }],
    query: operation("interventions.query", "查询介入事项", "interventions.query", ["/evidence", "/risks", "/recommendations", "/audit"], "人工介入 API 合同尚未集成"),
    commands: [operation("accept", "接受", "evidence.review", ["/evidence"], "证据审核 API 合同尚未集成"), operation("conditional", "有条件接受", "evidence.review", ["/evidence"], "证据审核 API 合同尚未集成"), operation("reject", "拒绝", "evidence.review", ["/evidence"], "证据审核 API 合同尚未集成"), operation("return", "退回", "interventions.resolve", ["/evidence", "/audit"], "介入退回 API 合同尚未集成")],
  },
  risks: {
    id: "risks",
    apiGroups: ["/risks"],
    tabs: [{ id: "open", label: "未解决" }, { id: "mine", label: "我的风险" }, { id: "resolved", label: "已解决" }],
    filters: [filter("severity", "严重性", [option("critical", "严重"), option("high", "高"), option("medium", "中"), option("low", "低")]), filter("sla", "SLA", [option("overdue", "已逾期"), option("due-soon", "即将到期")]), filter("owner", "负责人", []), filter("status", "状态", [option("open", "未解决"), option("resolved", "已解决")])],
    sortOptions: [option("severity-desc", "严重性"), option("updated-desc", "最近更新"), option("sla-asc", "SLA 时限")],
    columns: [{ key: "risk", label: "风险" }, { key: "severity", label: "严重性" }, { key: "owner", label: "负责人" }, { key: "status", label: "状态" }],
    query: operation("risks.query", "查询风险", "risks.query", ["/risks"], "风险 API 合同尚未集成"),
    commands: [operation("acknowledge", "确认风险", "risks.acknowledge", ["/risks"], "风险确认 API 合同尚未集成"), operation("assign", "分派风险", "risks.assign", ["/risks"], "风险分派 API 合同尚未集成"), operation("mitigate", "记录缓解", "risks.mitigate", ["/risks"], "风险缓解 API 合同尚未集成"), operation("escalate", "升级风险", "risks.escalate", ["/risks"], "风险升级 API 合同尚未集成"), operation("resolve", "解决风险", "risks.resolve", ["/risks"], "风险解决 API 合同尚未集成")],
  },
  resources: {
    id: "resources",
    apiGroups: ["/resources", "/reservations"],
    tabs: [{ id: "inventory", label: "资源库存" }, { id: "reservations", label: "预留" }, { id: "conflicts", label: "冲突" }],
    filters: [filter("type", "资源类型", []), filter("availability", "可用性", [option("available", "可用"), option("reserved", "已预留")]), filter("conflict", "冲突", [option("true", "存在冲突"), option("false", "无冲突")])],
    sortOptions: [option("name-asc", "名称"), option("availability-desc", "可用量")],
    columns: [{ key: "resource", label: "资源" }, { key: "type", label: "类型" }, { key: "availability", label: "可用量" }, { key: "reservation", label: "预留状态" }],
    query: operation("resources.query", "查询资源", "resources.query", ["/resources", "/reservations"], "资源 API 合同尚未集成"),
    commands: [operation("create", "创建资源", "resources.create", ["/resources"], "资源创建 API 合同尚未集成"), operation("change", "变更资源", "resources.change", ["/resources"], "资源变更 API 合同尚未集成"), operation("reserve", "创建预留", "reservations.create", ["/reservations"], "资源预留 API 合同尚未集成"), operation("cancel", "取消预留", "reservations.cancel", ["/reservations"], "预留取消 API 合同尚未集成")],
  },
  "domain-design": {
    id: "domain-design",
    apiGroups: ["/packages", "/package-versions", "/policy-releases"],
    tabs: [{ id: "drafts", label: "草稿" }, { id: "versions", label: "版本" }, { id: "validation", label: "校验" }, { id: "releases", label: "发布" }],
    filters: [filter("status", "状态", [option("draft", "草稿"), option("approved", "已批准"), option("published", "已发布")]), filter("validation", "校验结果", [option("passed", "通过"), option("failed", "失败")])],
    sortOptions: [option("updated-desc", "最近更新"), option("name-asc", "名称")],
    columns: [{ key: "package", label: "领域包" }, { key: "version", label: "版本" }, { key: "validation", label: "校验" }, { key: "status", label: "状态" }],
    query: operation("packages.query", "查询领域包", "packages.query", ["/packages", "/package-versions", "/policy-releases"], "领域包 API 合同尚未集成"),
    commands: [operation("import", "导入", "packages.import", ["/packages"], "领域包导入 API 合同尚未集成"), operation("validate", "校验", "packages.validate", ["/package-versions"], "领域包校验 API 合同尚未集成"), operation("diff", "比较版本", "packages.diff", ["/package-versions"], "版本比较 API 合同尚未集成"), operation("approve", "批准", "packages.approve", ["/package-versions"], "领域包批准 API 合同尚未集成"), operation("publish", "发布", "packages.publish", ["/policy-releases"], "领域包发布 API 合同尚未集成")],
  },
  administration: {
    id: "administration",
    apiGroups: ["/people", "/relationships", "/roles", "/policy-releases", "/providers", "/knowledge", "/audit"],
    tabs: [{ id: "people", label: "人员" }, { id: "relationships", label: "关系" }, { id: "roles", label: "角色" }, { id: "policies", label: "策略发布" }, { id: "providers", label: "智能服务" }, { id: "knowledge", label: "知识" }, { id: "audit", label: "审计" }],
    filters: [filter("status", "状态", [option("active", "启用"), option("disabled", "停用")]), filter("type", "类型", [])],
    sortOptions: [option("updated-desc", "最近更新"), option("name-asc", "名称")],
    columns: [{ key: "subject", label: "对象" }, { key: "type", label: "类型" }, { key: "status", label: "状态" }, { key: "updatedAt", label: "更新时间" }],
    query: operation("administration.query", "查询管理数据", "administration.query", ["/people", "/relationships", "/roles", "/policy-releases", "/providers", "/knowledge", "/audit"], "管理 API 合同尚未集成"),
    commands: [operation("create", "创建人员", "people.manage", ["/people"], "人员创建 API 合同尚未集成"), operation("disable", "停用人员", "people.manage", ["/people"], "人员停用 API 合同尚未集成"), operation("assign", "分配角色", "roles.manage", ["/relationships", "/roles"], "角色分配 API 合同尚未集成"), operation("release", "发布策略", "policies.manage", ["/policy-releases"], "策略发布 API 合同尚未集成"), operation("test", "测试智能服务", "providers.manage", ["/providers"], "智能服务测试 API 合同尚未集成"), operation("ingest", "导入知识", "knowledge.manage", ["/knowledge"], "知识导入 API 合同尚未集成"), operation("inspect", "检查审计", "audit.query", ["/audit"], "审计查询 API 合同尚未集成")],
  },
  system: {
    id: "system",
    apiGroups: ["/system", "/audit", "/events"],
    tabs: [{ id: "services", label: "服务" }, { id: "dependencies", label: "依赖" }, { id: "delivery", label: "事件投递" }],
    filters: [filter("state", "运行状态", [option("READY", "就绪"), option("DEGRADED", "降级"), option("UNREACHABLE", "不可达")])],
    sortOptions: [option("service-asc", "服务名称"), option("state-asc", "运行状态")],
    columns: [{ key: "service", label: "服务" }, { key: "version", label: "版本" }, { key: "state", label: "状态" }, { key: "freshness", label: "新鲜度" }],
    query: { operation: "system.status", label: "查询系统状态", capability: "occ.read", availability: available() },
    commands: [],
  },
  settings: {
    id: "settings",
    apiGroups: ["/auth", "/me"],
    tabs: [{ id: "profile", label: "服务器配置" }, { id: "trust", label: "TLS 信任" }, { id: "preferences", label: "偏好" }, { id: "session", label: "会话" }],
    filters: [],
    sortOptions: [option("name-asc", "配置名称")],
    columns: [{ key: "profile", label: "配置" }, { key: "environment", label: "环境" }, { key: "origin", label: "服务器" }, { key: "trust", label: "信任状态" }],
    query: { operation: "profiles.current", label: "读取当前配置", capability: "occ.read", availability: available() },
    commands: [
      { operation: "profiles.select", label: "选择配置", capability: "occ.read", availability: available() },
      { operation: "profiles.save", label: "保存配置", capability: "occ.read", availability: available() },
      { operation: "profiles.remove", label: "移除配置", capability: "occ.read", availability: available() },
      { operation: "session.logout", label: "退出登录", capability: "occ.read", availability: available() },
      operation("preferences.update", "更新偏好", "preferences.update", ["/me"], "个人偏好 API 合同尚未集成"),
    ],
  },
};

export const WORKSPACE_DEFINITIONS = deepFreeze(definitions);

export function commandFor(workspace: WorkspaceId | WorkspaceDefinition, operationName: string): WorkspaceOperation | undefined {
  const canonical = typeof workspace === "string" ? WORKSPACE_DEFINITIONS[workspace] : WORKSPACE_DEFINITIONS[workspace.id];
  if (!canonical || (typeof workspace !== "string" && canonical !== workspace)) return undefined;
  return canonical.commands.find(({ operation: name }) => name === operationName);
}
