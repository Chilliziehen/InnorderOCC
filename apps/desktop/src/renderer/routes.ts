import {
  Boxes,
  CircleGauge,
  FileCheck2,
  GitBranch,
  ListTodo,
  PackageOpen,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

export const ROUTE_PATHS = [
  "/overview",
  "/my-work",
  "/processes",
  "/interventions",
  "/risks",
  "/resources",
  "/domain-design",
  "/administration",
  "/system",
  "/settings",
] as const;

export type RoutePath = (typeof ROUTE_PATHS)[number];
export type RouteAccessCapability = "occ.read" | "occ.admin" | null;

export interface AppRoute {
  path: RoutePath;
  label: string;
  icon: LucideIcon;
  title: string;
  description: string;
  accessCapability: RouteAccessCapability;
  queryCapability: string;
  commandCapabilities: Readonly<Record<string, string>>;
  unavailableResourceGroups: readonly string[];
}

export const ROUTES: readonly AppRoute[] = [
  {
    path: "/overview",
    label: "总览",
    icon: CircleGauge,
    title: "运行总览",
    description: "关注事项、时限、风险与服务健康摘要",
    accessCapability: "occ.read",
    queryCapability: "overview.query",
    commandCapabilities: {},
    unavailableResourceGroups: ["/me", "/tasks", "/risks", "/system"],
  },
  {
    path: "/my-work",
    label: "我的工作",
    icon: ListTodo,
    title: "我的工作",
    description: "查看并处理分配、领取和退回的任务",
    accessCapability: "occ.read",
    queryCapability: "tasks.query",
    commandCapabilities: {
      claim: "tasks.claim",
      complete: "tasks.complete",
      return: "tasks.return",
      submitEvidence: "evidence.submit",
    },
    unavailableResourceGroups: ["/me", "/tasks", "/evidence", "/recommendations"],
  },
  {
    path: "/processes",
    label: "流程",
    icon: GitBranch,
    title: "流程",
    description: "检查流程进度、参与者、任务与时间线",
    accessCapability: "occ.read",
    queryCapability: "processes.query",
    commandCapabilities: {
      start: "processes.start",
      suspend: "processes.suspend",
      cancel: "processes.cancel",
    },
    unavailableResourceGroups: ["/cohorts", "/processes", "/tasks", "/events"],
  },
  {
    path: "/interventions",
    label: "介入中心",
    icon: FileCheck2,
    title: "人工介入中心",
    description: "处理审核、异常、策略阻断和建议",
    accessCapability: "occ.read",
    queryCapability: "interventions.query",
    commandCapabilities: {
      reviewEvidence: "evidence.review",
      resolveException: "interventions.resolve",
      reviewRecommendation: "recommendations.review",
    },
    unavailableResourceGroups: ["/evidence", "/tasks", "/recommendations", "/events"],
  },
  {
    path: "/risks",
    label: "风险",
    icon: ShieldAlert,
    title: "风险",
    description: "跟踪风险分派、缓解、升级与解决",
    accessCapability: "occ.read",
    queryCapability: "risks.query",
    commandCapabilities: {
      acknowledge: "risks.acknowledge",
      assign: "risks.assign",
      mitigate: "risks.mitigate",
      escalate: "risks.escalate",
      resolve: "risks.resolve",
    },
    unavailableResourceGroups: ["/risks", "/events"],
  },
  {
    path: "/resources",
    label: "资源",
    icon: Boxes,
    title: "资源",
    description: "查看库存与可用性并管理预留",
    accessCapability: "occ.read",
    queryCapability: "resources.query",
    commandCapabilities: {
      reserve: "reservations.create",
      changeReservation: "reservations.change",
      cancelReservation: "reservations.cancel",
    },
    unavailableResourceGroups: ["/resources", "/reservations"],
  },
  {
    path: "/domain-design",
    label: "领域设计",
    icon: PackageOpen,
    title: "领域设计",
    description: "设计、校验、审批并发布领域包",
    accessCapability: "occ.admin",
    queryCapability: "packages.query",
    commandCapabilities: {
      import: "packages.import",
      validate: "packages.validate",
      approve: "packages.approve",
      publish: "packages.publish",
    },
    unavailableResourceGroups: ["/packages", "/package-versions", "/policy-releases"],
  },
  {
    path: "/administration",
    label: "管理",
    icon: UsersRound,
    title: "管理",
    description: "管理人员、角色、策略与智能服务配置",
    accessCapability: "occ.admin",
    queryCapability: "administration.query",
    commandCapabilities: {
      managePeople: "people.manage",
      manageRoles: "roles.manage",
      managePolicies: "policies.manage",
      manageProviders: "providers.manage",
      manageKnowledge: "knowledge.manage",
    },
    unavailableResourceGroups: [
      "/people",
      "/relationships",
      "/roles",
      "/policy-releases",
      "/providers",
      "/knowledge",
    ],
  },
  {
    path: "/system",
    label: "系统",
    icon: Settings,
    title: "系统运行",
    description: "查看服务、依赖与运行状态",
    accessCapability: "occ.read",
    queryCapability: "system.query",
    commandCapabilities: {},
    unavailableResourceGroups: ["/system", "/audit", "/events"],
  },
  {
    path: "/settings",
    label: "设置",
    icon: SlidersHorizontal,
    title: "设置",
    description: "管理个人偏好与当前环境信息",
    accessCapability: null,
    queryCapability: "preferences.query",
    commandCapabilities: { updatePreferences: "preferences.update" },
    unavailableResourceGroups: ["/me"],
  },
] as const;

export const DEFAULT_ROUTE_PATH: RoutePath = "/overview";

const routesByPath = new Map<string, AppRoute>(
  ROUTES.map((route) => [route.path, route]),
);

function hasCapability(capabilities: readonly string[], required: string): boolean {
  return capabilities.includes(required);
}

export function isRoutePath(path: string): path is RoutePath {
  return routesByPath.has(path);
}

export function canAccessRoute(
  path: string,
  capabilities: readonly string[],
): boolean {
  const route = routesByPath.get(path);
  return route !== undefined && (
    route.accessCapability === null ||
    hasCapability(capabilities, route.accessCapability)
  );
}

export function visibleRoutes(capabilities: readonly string[]): AppRoute[] {
  return ROUTES.filter(({ path }) => canAccessRoute(path, capabilities));
}

export function canRunQuery(
  route: AppRoute,
  capabilities: readonly string[],
): boolean {
  return hasCapability(capabilities, route.queryCapability);
}

export function canRunCommand(
  route: AppRoute,
  operation: string,
  capabilities: readonly string[],
): boolean {
  const required = route.commandCapabilities[operation];
  return required !== undefined && hasCapability(capabilities, required);
}

export type RouteResolution =
  | { kind: "route"; route: AppRoute; queryAllowed: boolean }
  | { kind: "access-denied"; path: RoutePath }
  | { kind: "not-found"; path: string };

export function resolveRoute(
  path: string,
  capabilities: readonly string[],
): RouteResolution {
  const route = routesByPath.get(path);
  if (!route) return { kind: "not-found", path };
  if (!canAccessRoute(path, capabilities)) {
    return { kind: "access-denied", path: route.path };
  }
  return { kind: "route", route, queryAllowed: canRunQuery(route, capabilities) };
}

export function routePathFromHash(hash: string): RoutePath | null {
  const encoded = hash.startsWith("#") ? hash.slice(1) : hash;
  if (encoded === "") return DEFAULT_ROUTE_PATH;
  try {
    const decoded = decodeURIComponent(encoded);
    return isRoutePath(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export interface RouteLocation {
  path: RoutePath | null;
  focusToken: number;
}

interface HashWindow {
  location: Pick<Location, "hash">;
  addEventListener(type: "hashchange", listener: () => void): void;
  removeEventListener(type: "hashchange", listener: () => void): void;
}

export interface HashRouter {
  get(): RouteLocation;
  set(path: string): boolean;
  subscribe(listener: (location: RouteLocation) => void): () => void;
}

export function createHashRouter(target: HashWindow = window): HashRouter {
  let focusToken = 0;
  const listeners = new Set<(location: RouteLocation) => void>();
  const onHashChange = () => {
    focusToken += 1;
    const location = { path: routePathFromHash(target.location.hash), focusToken };
    for (const listener of listeners) listener(location);
  };

  return {
    get() {
      return { path: routePathFromHash(target.location.hash), focusToken };
    },
    set(path) {
      if (!isRoutePath(path)) return false;
      target.location.hash = `#${path}`;
      return true;
    },
    subscribe(listener) {
      if (listeners.size === 0) target.addEventListener("hashchange", onHashChange);
      const subscription = (location: RouteLocation) => listener(location);
      listeners.add(subscription);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(subscription);
        if (listeners.size === 0) {
          target.removeEventListener("hashchange", onHashChange);
        }
      };
    },
  };
}
