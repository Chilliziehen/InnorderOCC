export interface MainUnavailableOperation {
  readonly state: "unavailable";
  readonly reason: "UNAVAILABLE_CONTRACT";
  readonly resourceGroups: string[];
  readonly message: string;
}

type OperationEntry = readonly [workspace: string, operation: string, resourceGroups: readonly string[], message: string];

const entries: readonly OperationEntry[] = [
  ["overview", "overview.query", ["/me", "/tasks", "/processes", "/risks"], "总览业务 API 合同尚未集成"],
  ["my-work", "tasks.query", ["/tasks"], "任务 API 合同尚未集成"],
  ["my-work", "claim", ["/tasks"], "任务领取 API 合同尚未集成"],
  ["my-work", "submitEvidence", ["/evidence"], "证据提交 API 合同尚未集成"],
  ["my-work", "reserve", ["/reservations"], "资源预留 API 合同尚未集成"],
  ["my-work", "guidance", ["/recommendations"], "智能建议 API 合同尚未集成"],
  ["processes", "processes.query", ["/cohorts", "/processes", "/tasks"], "流程 API 合同尚未集成"],
  ["processes", "create", ["/cohorts"], "群组创建 API 合同尚未集成"],
  ["processes", "start", ["/processes"], "流程启动 API 合同尚未集成"],
  ["processes", "suspend", ["/processes"], "流程暂停 API 合同尚未集成"],
  ["processes", "cancel", ["/processes"], "流程取消 API 合同尚未集成"],
  ["interventions", "interventions.query", ["/evidence", "/risks", "/recommendations", "/audit"], "人工介入 API 合同尚未集成"],
  ["interventions", "accept", ["/evidence"], "证据审核 API 合同尚未集成"],
  ["interventions", "conditional", ["/evidence"], "证据审核 API 合同尚未集成"],
  ["interventions", "reject", ["/evidence"], "证据审核 API 合同尚未集成"],
  ["interventions", "return", ["/evidence", "/audit"], "介入退回 API 合同尚未集成"],
  ["risks", "risks.query", ["/risks"], "风险 API 合同尚未集成"],
  ["risks", "acknowledge", ["/risks"], "风险确认 API 合同尚未集成"],
  ["risks", "assign", ["/risks"], "风险分派 API 合同尚未集成"],
  ["risks", "mitigate", ["/risks"], "风险缓解 API 合同尚未集成"],
  ["risks", "escalate", ["/risks"], "风险升级 API 合同尚未集成"],
  ["risks", "resolve", ["/risks"], "风险解决 API 合同尚未集成"],
  ["resources", "resources.query", ["/resources", "/reservations"], "资源 API 合同尚未集成"],
  ["resources", "create", ["/resources"], "资源创建 API 合同尚未集成"],
  ["resources", "change", ["/resources"], "资源变更 API 合同尚未集成"],
  ["resources", "reserve", ["/reservations"], "资源预留 API 合同尚未集成"],
  ["resources", "cancel", ["/reservations"], "预留取消 API 合同尚未集成"],
  ["domain-design", "packages.query", ["/packages", "/package-versions", "/policy-releases"], "领域包 API 合同尚未集成"],
  ["domain-design", "import", ["/packages"], "领域包导入 API 合同尚未集成"],
  ["domain-design", "validate", ["/package-versions"], "领域包校验 API 合同尚未集成"],
  ["domain-design", "diff", ["/package-versions"], "版本比较 API 合同尚未集成"],
  ["domain-design", "approve", ["/package-versions"], "领域包批准 API 合同尚未集成"],
  ["domain-design", "publish", ["/policy-releases"], "领域包发布 API 合同尚未集成"],
  ["administration", "administration.query", ["/people", "/relationships", "/roles", "/policy-releases", "/providers", "/knowledge", "/audit"], "管理 API 合同尚未集成"],
  ["administration", "create", ["/people"], "人员创建 API 合同尚未集成"],
  ["administration", "disable", ["/people"], "人员停用 API 合同尚未集成"],
  ["administration", "assign", ["/relationships", "/roles"], "角色分配 API 合同尚未集成"],
  ["administration", "release", ["/policy-releases"], "策略发布 API 合同尚未集成"],
  ["administration", "test", ["/providers"], "智能服务测试 API 合同尚未集成"],
  ["administration", "ingest", ["/knowledge"], "知识导入 API 合同尚未集成"],
  ["administration", "inspect", ["/audit"], "审计查询 API 合同尚未集成"],
  ["settings", "preferences.update", ["/me"], "个人偏好 API 合同尚未集成"],
  ["system", "notifications.list", ["/notifications"], "通知 API 合同尚未集成"],
];

const registry = new Map<string, MainUnavailableOperation>(entries.map(([workspace, operation, resourceGroups, message]) => [
  `${workspace}:${operation}`,
  { state: "unavailable", reason: "UNAVAILABLE_CONTRACT", resourceGroups: [...resourceGroups], message },
]));

export function mainUnavailableOperation(
  workspace: string,
  operation: string,
  fallbackGroup: "/workspaces" | "/commands",
): MainUnavailableOperation {
  return registry.get(`${workspace}:${operation}`) ?? {
    state: "unavailable",
    reason: "UNAVAILABLE_CONTRACT",
    resourceGroups: [fallbackGroup],
    message: `${operation} API contract is unavailable`,
  };
}

export function mainUnavailableNotificationList(): MainUnavailableOperation {
  return mainUnavailableOperation("system", "notifications.list", "/workspaces");
}

export function mainUnavailableEvidenceUpload(): MainUnavailableOperation {
  return mainUnavailableOperation("my-work", "submitEvidence", "/commands");
}
