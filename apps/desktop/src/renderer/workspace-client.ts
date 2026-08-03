import type { WorkspaceQuery, WorkspaceResult } from "../desktop-contract";
import type { WorkspaceQueryValue } from "./components/QueryToolbar";
import type { WorkspaceDefinition } from "./workspaces/workspace-definitions";

export function workspaceQueryInput(
  definition: WorkspaceDefinition,
  query: WorkspaceQueryValue,
  activeTab: string,
): WorkspaceQuery {
  const separator = query.sort.lastIndexOf("-");
  const direction = query.sort.slice(separator + 1);
  const sort = separator > 0 && (direction === "asc" || direction === "desc")
    ? { field: query.sort.slice(0, separator), direction: direction as "asc" | "desc" }
    : undefined;
  return {
    workspace: definition.id,
    operation: definition.query.operation,
    filters: { ...query.filters, search: query.search, tab: activeTab },
    ...(sort ? { sort } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
    limit: 50,
  };
}

export function unavailableWorkspaceResult(definition: WorkspaceDefinition): WorkspaceResult {
  if (definition.query.availability.state === "unavailable") {
    return {
      state: "unavailable",
      reason: definition.query.availability.reason,
      resourceGroups: [...definition.query.availability.resourceGroups],
      message: definition.query.availability.message,
    };
  }
  return {
    state: "unavailable",
    reason: "UNAVAILABLE_CONTRACT",
    resourceGroups: [...definition.apiGroups],
    message: "工作区数据接口尚不可用",
  };
}

export function failedWorkspaceResult(): WorkspaceResult {
  return {
    state: "error",
    problem: {
      title: "无法加载工作区数据，请重试。",
      code: "WORKSPACE_QUERY_FAILED",
      status: 503,
      retryable: true,
    },
  };
}
