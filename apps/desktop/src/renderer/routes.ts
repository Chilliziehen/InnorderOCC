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

import {
  WORKSPACE_MANIFEST,
  type RouteAccessCapability,
  type RoutePath,
  type WorkspaceId,
} from "./workspace-manifest";

export type { RouteAccessCapability, RoutePath } from "./workspace-manifest";

export const ROUTE_PATHS: readonly RoutePath[] = Object.freeze(
  WORKSPACE_MANIFEST.map(({ path }) => path),
);

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

const ICONS: Readonly<Record<WorkspaceId, LucideIcon>> = Object.freeze({
  overview: CircleGauge,
  "my-work": ListTodo,
  processes: GitBranch,
  interventions: FileCheck2,
  risks: ShieldAlert,
  resources: Boxes,
  "domain-design": PackageOpen,
  administration: UsersRound,
  system: Settings,
  settings: SlidersHorizontal,
});

export const ROUTES: readonly AppRoute[] = Object.freeze(
  WORKSPACE_MANIFEST.map((workspace) => Object.freeze({
    path: workspace.path,
    label: workspace.label,
    icon: ICONS[workspace.id],
    title: workspace.title,
    description: workspace.description,
    accessCapability: workspace.accessCapability,
    queryCapability: workspace.query.capability,
    commandCapabilities: Object.freeze(Object.fromEntries(
      workspace.commands.map(({ operation, capability }) => [operation, capability]),
    )),
    unavailableResourceGroups: workspace.resourceGroups,
  })),
);

export const DEFAULT_ROUTE_PATH: RoutePath = "/overview";

const routesByPath = Object.freeze(
  Object.fromEntries(ROUTES.map((route) => [route.path, route])),
) as Readonly<Partial<Record<RoutePath, AppRoute>>>;

function canonicalRoute(route: Pick<AppRoute, "path"> | string): AppRoute | undefined {
  const path = typeof route === "string" ? route : route.path;
  return Object.hasOwn(routesByPath, path)
    ? routesByPath[path as RoutePath]
    : undefined;
}

function hasCapability(capabilities: readonly string[], required: string): boolean {
  return capabilities.includes(required);
}

export function isRoutePath(path: string): path is RoutePath {
  return canonicalRoute(path) !== undefined;
}

export function canAccessRoute(
  path: string,
  capabilities: readonly string[],
): boolean {
  const route = canonicalRoute(path);
  return route !== undefined && (
    route.accessCapability === null ||
    hasCapability(capabilities, route.accessCapability)
  );
}

export function visibleRoutes(capabilities: readonly string[]): AppRoute[] {
  return ROUTES.filter(({ path }) => canAccessRoute(path, capabilities));
}

export function canRunQuery(
  route: Pick<AppRoute, "path"> | string,
  capabilities: readonly string[],
): boolean {
  const canonical = canonicalRoute(route);
  return canonical !== undefined && hasCapability(capabilities, canonical.queryCapability);
}

export function canRunCommand(
  route: Pick<AppRoute, "path"> | string,
  operation: string,
  capabilities: readonly string[],
): boolean {
  const required = canonicalRoute(route)?.commandCapabilities[operation];
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
  const route = canonicalRoute(path);
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
