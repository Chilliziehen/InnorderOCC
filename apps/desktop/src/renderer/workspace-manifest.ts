export const WORKSPACE_IDS = [
  "overview",
  "my-work",
  "processes",
  "interventions",
  "risks",
  "resources",
  "domain-design",
  "administration",
  "system",
  "settings",
] as const;

export type WorkspaceId = (typeof WORKSPACE_IDS)[number];
export type RoutePath = `/${WorkspaceId}`;
export type RouteAccessCapability = "occ.read" | "occ.admin" | null;

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

export interface WorkspaceManifestEntry {
  readonly id: WorkspaceId;
  readonly path: RoutePath;
  readonly label: string;
  readonly title: string;
  readonly description: string;
  readonly accessCapability: RouteAccessCapability;
  readonly resourceGroups: readonly string[];
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
const operation = (
  name: string,
  label: string,
  capability: string,
  groups: readonly string[],
  message: string,
): WorkspaceOperation => ({
  operation: name,
  label,
  capability,
  availability: unavailable(groups, message),
});

const manifest: WorkspaceManifestEntry[] = [
  {
    id: "overview", path: "/overview", label: "总览", title: "运行总览",
    description: "关注事项、时限、风险与服务健康摘要", accessCapability: "occ.read",
    resourceGroups: ["/me", "/tasks", "/processes", "/risks", "/system"],
    query: operation("overview.query", "查询运行总览", "overview.query", ["/me", "/tasks", "/processes", "/risks"], "总览业务 API 合同尚未集成"),
    commands: [],
  },
  {
    id: "my-work", path: "/my-work", label: "我的工作", title: "我的工作",
    description: "查看并处理分配、领取和退回的任务", accessCapability: "occ.read",
    resourceGroups: ["/tasks", "/evidence", "/reservations", "/recommendations"],
    query: operation("tasks.query", "查询我的工作", "tasks.query", ["/tasks"], "任务 API 合同尚未集成"),
    commands: [
      operation("claim", "领取任务", "tasks.claim", ["/tasks"], "任务领取 API 合同尚未集成"),
      operation("submitEvidence", "提交证据", "evidence.submit", ["/evidence"], "证据提交 API 合同尚未集成"),
      operation("reserve", "预留资源", "reservations.create", ["/reservations"], "资源预留 API 合同尚未集成"),
      operation("guidance", "请求智能建议", "recommendations.request", ["/recommendations"], "智能建议 API 合同尚未集成"),
    ],
  },
  {
    id: "processes", path: "/processes", label: "流程", title: "流程",
    description: "检查流程进度、参与者、任务与时间线", accessCapability: "occ.read",
    resourceGroups: ["/cohorts", "/processes", "/tasks"],
    query: operation("processes.query", "查询流程", "processes.query", ["/cohorts", "/processes", "/tasks"], "流程 API 合同尚未集成"),
    commands: [
      operation("create", "创建群组", "cohorts.create", ["/cohorts"], "群组创建 API 合同尚未集成"),
      operation("start", "启动流程", "processes.start", ["/processes"], "流程启动 API 合同尚未集成"),
      operation("suspend", "暂停流程", "processes.suspend", ["/processes"], "流程暂停 API 合同尚未集成"),
      operation("cancel", "取消流程", "processes.cancel", ["/processes"], "流程取消 API 合同尚未集成"),
    ],
  },
  {
    id: "interventions", path: "/interventions", label: "介入中心", title: "人工介入中心",
    description: "处理审核、异常、策略阻断和建议", accessCapability: "occ.read",
    resourceGroups: ["/evidence", "/risks", "/recommendations", "/audit"],
    query: operation("interventions.query", "查询介入事项", "interventions.query", ["/evidence", "/risks", "/recommendations", "/audit"], "人工介入 API 合同尚未集成"),
    commands: [
      operation("accept", "接受", "evidence.review", ["/evidence"], "证据审核 API 合同尚未集成"),
      operation("conditional", "有条件接受", "evidence.review", ["/evidence"], "证据审核 API 合同尚未集成"),
      operation("reject", "拒绝", "evidence.review", ["/evidence"], "证据审核 API 合同尚未集成"),
      operation("return", "退回", "interventions.resolve", ["/evidence", "/audit"], "介入退回 API 合同尚未集成"),
    ],
  },
  {
    id: "risks", path: "/risks", label: "风险", title: "风险",
    description: "跟踪风险分派、缓解、升级与解决", accessCapability: "occ.read",
    resourceGroups: ["/risks"],
    query: operation("risks.query", "查询风险", "risks.query", ["/risks"], "风险 API 合同尚未集成"),
    commands: [
      operation("acknowledge", "确认风险", "risks.acknowledge", ["/risks"], "风险确认 API 合同尚未集成"),
      operation("assign", "分派风险", "risks.assign", ["/risks"], "风险分派 API 合同尚未集成"),
      operation("mitigate", "记录缓解", "risks.mitigate", ["/risks"], "风险缓解 API 合同尚未集成"),
      operation("escalate", "升级风险", "risks.escalate", ["/risks"], "风险升级 API 合同尚未集成"),
      operation("resolve", "解决风险", "risks.resolve", ["/risks"], "风险解决 API 合同尚未集成"),
    ],
  },
  {
    id: "resources", path: "/resources", label: "资源", title: "资源",
    description: "查看库存与可用性并管理预留", accessCapability: "occ.read",
    resourceGroups: ["/resources", "/reservations"],
    query: operation("resources.query", "查询资源", "resources.query", ["/resources", "/reservations"], "资源 API 合同尚未集成"),
    commands: [
      operation("create", "创建资源", "resources.create", ["/resources"], "资源创建 API 合同尚未集成"),
      operation("change", "变更资源", "resources.change", ["/resources"], "资源变更 API 合同尚未集成"),
      operation("reserve", "创建预留", "reservations.create", ["/reservations"], "资源预留 API 合同尚未集成"),
      operation("cancel", "取消预留", "reservations.cancel", ["/reservations"], "预留取消 API 合同尚未集成"),
    ],
  },
  {
    id: "domain-design", path: "/domain-design", label: "领域设计", title: "领域设计",
    description: "设计、校验、审批并发布领域包", accessCapability: "occ.admin",
    resourceGroups: ["/packages", "/package-versions", "/policy-releases"],
    query: operation("packages.query", "查询领域包", "packages.query", ["/packages", "/package-versions", "/policy-releases"], "领域包 API 合同尚未集成"),
    commands: [
      operation("import", "导入", "packages.import", ["/packages"], "领域包导入 API 合同尚未集成"),
      operation("validate", "校验", "packages.validate", ["/package-versions"], "领域包校验 API 合同尚未集成"),
      operation("diff", "比较版本", "packages.diff", ["/package-versions"], "版本比较 API 合同尚未集成"),
      operation("approve", "批准", "packages.approve", ["/package-versions"], "领域包批准 API 合同尚未集成"),
      operation("publish", "发布", "packages.publish", ["/policy-releases"], "领域包发布 API 合同尚未集成"),
    ],
  },
  {
    id: "administration", path: "/administration", label: "管理", title: "管理",
    description: "管理人员、角色、策略与智能服务配置", accessCapability: "occ.admin",
    resourceGroups: ["/people", "/relationships", "/roles", "/policy-releases", "/providers", "/knowledge", "/audit"],
    query: operation("administration.query", "查询管理数据", "administration.query", ["/people", "/relationships", "/roles", "/policy-releases", "/providers", "/knowledge", "/audit"], "管理 API 合同尚未集成"),
    commands: [
      operation("create", "创建人员", "people.manage", ["/people"], "人员创建 API 合同尚未集成"),
      operation("disable", "停用人员", "people.manage", ["/people"], "人员停用 API 合同尚未集成"),
      operation("assignRelationship", "分配关系", "relationships.manage", ["/relationships"], "关系分配 API 合同尚未集成"),
      operation("assign", "分配角色", "roles.manage", ["/roles"], "角色分配 API 合同尚未集成"),
      operation("release", "发布策略", "policies.manage", ["/policy-releases"], "策略发布 API 合同尚未集成"),
      operation("test", "测试智能服务", "providers.manage", ["/providers"], "智能服务测试 API 合同尚未集成"),
      operation("ingest", "导入知识", "knowledge.manage", ["/knowledge"], "知识导入 API 合同尚未集成"),
      operation("inspect", "检查审计", "audit.query", ["/audit"], "审计查询 API 合同尚未集成"),
    ],
  },
  {
    id: "system", path: "/system", label: "系统", title: "系统运行",
    description: "查看服务、依赖与运行状态", accessCapability: "occ.read",
    resourceGroups: ["/system", "/audit", "/events"],
    query: { operation: "system.status", label: "查询系统状态", capability: "occ.read", availability: available() },
    commands: [],
  },
  {
    id: "settings", path: "/settings", label: "设置", title: "设置",
    description: "管理个人偏好与当前环境信息", accessCapability: null,
    resourceGroups: ["/auth", "/me"],
    query: { operation: "profiles.current", label: "读取当前配置", capability: "occ.read", availability: available() },
    commands: [
      { operation: "profiles.select", label: "选择配置", capability: "occ.read", availability: available() },
      { operation: "profiles.save", label: "保存配置", capability: "occ.read", availability: available() },
      { operation: "profiles.remove", label: "移除配置", capability: "occ.read", availability: available() },
      { operation: "session.logout", label: "退出登录", capability: "occ.read", availability: available() },
      operation("preferences.update", "更新偏好", "preferences.update", ["/me"], "个人偏好 API 合同尚未集成"),
    ],
  },
];

export const WORKSPACE_MANIFEST = deepFreeze(manifest);
export const WORKSPACE_MANIFEST_BY_ID = deepFreeze(
  Object.fromEntries(WORKSPACE_MANIFEST.map((workspace) => [workspace.id, workspace])),
) as Readonly<Record<WorkspaceId, WorkspaceManifestEntry>>;
