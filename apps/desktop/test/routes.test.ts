import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_ROUTE_PATH,
  ROUTES,
  canAccessRoute,
  canRunCommand,
  canRunQuery,
  createHashRouter,
  resolveRoute,
  routePathFromHash,
  visibleRoutes,
} from "../src/renderer/routes";

const APPROVED_PATHS = [
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
];

const EXACT_MANIFEST = [
  {
    path: "/overview",
    label: "总览",
    title: "运行总览",
    accessCapability: "occ.read",
    queryCapability: "overview.query",
    commandCapabilities: {},
    unavailableResourceGroups: ["/me", "/tasks", "/risks", "/system"],
  },
  {
    path: "/my-work",
    label: "我的工作",
    title: "我的工作",
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
    title: "流程",
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
    title: "人工介入中心",
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
    title: "风险",
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
    title: "资源",
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
    title: "领域设计",
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
    title: "管理",
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
    title: "系统运行",
    accessCapability: "occ.read",
    queryCapability: "system.query",
    commandCapabilities: {},
    unavailableResourceGroups: ["/system", "/audit", "/events"],
  },
  {
    path: "/settings",
    label: "设置",
    title: "设置",
    accessCapability: null,
    queryCapability: "preferences.query",
    commandCapabilities: { updatePreferences: "preferences.update" },
    unavailableResourceGroups: ["/me"],
  },
];

describe("route manifest", () => {
  it("defines every approved route with display and unavailable-contract metadata", () => {
    expect(ROUTES.map(({ path }) => path)).toEqual(APPROVED_PATHS);
    for (const route of ROUTES) {
      expect(route.label).toMatch(/[\u3400-\u9fff]/u);
      expect(route.title).toMatch(/[\u3400-\u9fff]/u);
      expect(route.description.length).toBeGreaterThan(0);
      expect(typeof route.icon).toBe("object");
      expect(route.queryCapability).toMatch(/\.query$/);
      expect(route.commandCapabilities).toBeTypeOf("object");
      expect(route.unavailableResourceGroups.length).toBeGreaterThan(0);
    }
  });

  it("pins the complete capability and unavailable-resource manifest", () => {
    expect(
      ROUTES.map(({ icon: _icon, description: _description, ...metadata }) => metadata),
    ).toEqual(EXACT_MANIFEST);
  });

  it("shows coarse read surfaces, protects admin surfaces, and keeps settings authenticated", () => {
    expect(visibleRoutes(["occ.read"]).map(({ path }) => path)).toEqual([
      "/overview",
      "/my-work",
      "/processes",
      "/interventions",
      "/risks",
      "/resources",
      "/system",
      "/settings",
    ]);
    expect(canAccessRoute("/domain-design", ["occ.read"])).toBe(false);
    expect(canAccessRoute("/administration", ["occ.read"])).toBe(false);
    expect(canAccessRoute("/administration", ["occ.admin"])).toBe(true);
    expect(canAccessRoute("/settings", [])).toBe(true);
  });

  it("requires exact query and command capabilities without occ.execute fallback", () => {
    const processes = ROUTES.find(({ path }) => path === "/processes")!;
    expect(canRunQuery(processes, ["occ.read"])).toBe(false);
    expect(canRunQuery(processes, [processes.queryCapability])).toBe(true);

    const command = processes.commandCapabilities.start;
    expect(command).toBeTruthy();
    if (!command) throw new Error("process start capability is missing");
    expect(canRunCommand(processes, "start", ["occ.execute"])).toBe(false);
    expect(canRunCommand(processes, "start", [command])).toBe(true);
    expect(canRunCommand(processes, "not-a-command", ["occ.admin"])).toBe(false);
  });

  it("default-denies every command except its exact capability", () => {
    for (const route of ROUTES) {
      const exactCapabilities = Object.values(route.commandCapabilities);
      for (const [operation, capability] of Object.entries(route.commandCapabilities)) {
        expect(canRunCommand(route, operation, [])).toBe(false);
        expect(canRunCommand(route, operation, ["occ.read"])).toBe(false);
        expect(canRunCommand(route, operation, ["occ.execute"])).toBe(false);
        expect(canRunCommand(route, operation, ["occ.admin"])).toBe(false);
        expect(canRunCommand(route, operation, [capability])).toBe(true);
      }
      expect(canRunCommand(route, "unknown", ["occ.read", "occ.execute", "occ.admin"])).toBe(false);
      expect(canRunCommand(route, "unknown", exactCapabilities)).toBe(false);
    }
  });

  it("returns access denied before exposing query permission and not found for unknown paths", () => {
    expect(resolveRoute("/administration", ["occ.read"])).toEqual({
      kind: "access-denied",
      path: "/administration",
    });
    expect(resolveRoute("/unknown", ["occ.admin"])).toEqual({
      kind: "not-found",
      path: "/unknown",
    });
  });
});

describe("hash router", () => {
  it("defaults an empty hash and accepts only safely decoded exact paths", () => {
    expect(DEFAULT_ROUTE_PATH).toBe("/overview");
    expect(routePathFromHash("")).toBe("/overview");
    expect(routePathFromHash("#")).toBe("/overview");
    expect(routePathFromHash("#/my-work")).toBe("/my-work");
    expect(routePathFromHash("#%2Fmy-work")).toBe("/my-work");
    expect(routePathFromHash("#/my-work/")).toBeNull();
    expect(routePathFromHash("#/my-work?tab=all")).toBeNull();
    expect(routePathFromHash("#https://example.test")).toBeNull();
    expect(routePathFromHash("#%E0%A4%A")).toBeNull();
  });

  it("subscribes with increasing focus tokens, sets only approved hashes, and disposes", () => {
    window.location.hash = "";
    const router = createHashRouter(window);
    const listener = vi.fn();
    const dispose = router.subscribe(listener);

    expect(router.get()).toEqual({ path: "/overview", focusToken: 0 });
    expect(router.set("/risks")).toBe(true);
    expect(window.location.hash).toBe("#/risks");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(listener).toHaveBeenLastCalledWith({ path: "/risks", focusToken: 1 });

    expect(router.set("/outside")).toBe(false);
    expect(window.location.hash).toBe("#/risks");
    window.location.hash = "#%E0%A4%A";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(listener).toHaveBeenLastCalledWith({ path: null, focusToken: 2 });

    dispose();
    window.location.hash = "#/overview";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("delivers one focus token to all current subscribers", () => {
    window.location.hash = "#/overview";
    const router = createHashRouter(window);
    const first = vi.fn();
    const second = vi.fn();
    const disposeFirst = router.subscribe(first);
    const disposeSecond = router.subscribe(second);

    window.location.hash = "#/system";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(first).toHaveBeenCalledWith({ path: "/system", focusToken: 1 });
    expect(second).toHaveBeenCalledWith({ path: "/system", focusToken: 1 });

    disposeFirst();
    window.location.hash = "#/settings";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenLastCalledWith({ path: "/settings", focusToken: 2 });
    disposeSecond();
  });

  it("owns duplicate callback subscriptions independently with idempotent disposal", () => {
    const handlers = new Set<() => void>();
    const target = {
      location: { hash: "#/overview" },
      addEventListener: vi.fn((_type: "hashchange", handler: () => void) => {
        handlers.add(handler);
      }),
      removeEventListener: vi.fn((_type: "hashchange", handler: () => void) => {
        handlers.delete(handler);
      }),
    };
    const router = createHashRouter(target);
    const listener = vi.fn();
    const disposeFirst = router.subscribe(listener);
    const disposeSecond = router.subscribe(listener);

    target.location.hash = "#/risks";
    for (const handler of handlers) handler();
    expect(listener).toHaveBeenCalledTimes(2);

    disposeFirst();
    disposeFirst();
    target.location.hash = "#/system";
    for (const handler of handlers) handler();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(target.removeEventListener).not.toHaveBeenCalled();

    disposeSecond();
    disposeSecond();
    expect(target.removeEventListener).toHaveBeenCalledTimes(1);
    target.location.hash = "#/settings";
    for (const handler of handlers) handler();
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
