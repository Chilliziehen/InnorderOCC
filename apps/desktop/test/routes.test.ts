import { describe, expect, it, vi } from "vitest";
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
} from "lucide-react";

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
  "/overview", "/my-work", "/processes", "/interventions", "/risks",
  "/resources", "/domain-design", "/administration", "/system", "/settings",
];

const APPROVED_ICONS = [
  CircleGauge, ListTodo, GitBranch, FileCheck2, ShieldAlert,
  Boxes, PackageOpen, UsersRound, Settings, SlidersHorizontal,
];

describe("route manifest", () => {
  it("defines every approved route with display, icon, and policy metadata", () => {
    expect(ROUTES.map(({ path }) => path)).toEqual(APPROVED_PATHS);
    expect(ROUTES.map(({ icon }) => icon)).toEqual(APPROVED_ICONS);
    for (const route of ROUTES) {
      expect(route.label).toMatch(/[\u3400-\u9fff]/u);
      expect(route.title).toMatch(/[\u3400-\u9fff]/u);
      expect(route.description.length).toBeGreaterThan(0);
      expect(route.queryCapability).not.toBe("");
      expect(route.commandCapabilities).toBeTypeOf("object");
      expect(route.unavailableResourceGroups.length).toBeGreaterThan(0);
    }
  });

  it("deeply freezes the derived route metadata", () => {
    expect(Object.isFrozen(ROUTES)).toBe(true);
    for (const route of ROUTES) {
      expect(Object.isFrozen(route)).toBe(true);
      expect(Object.isFrozen(route.commandCapabilities)).toBe(true);
      expect(Object.isFrozen(route.unavailableResourceGroups)).toBe(true);
    }

    const processes = ROUTES.find(({ path }) => path === "/processes")!;
    expect(() => void ((processes as { label: string }).label = "伪造")).toThrow(TypeError);
    expect(() => void ((processes.commandCapabilities as Record<string, string>).start = "occ.execute")).toThrow(TypeError);
    expect(() => void ((processes.unavailableResourceGroups as string[]).push("/forged"))).toThrow(TypeError);
  });

  it("resolves canonical route policy instead of trusting forged metadata", () => {
    const processes = ROUTES.find(({ path }) => path === "/processes")!;
    const forged = { ...processes, queryCapability: "occ.read", commandCapabilities: { start: "occ.execute" } };
    const unknown = { ...forged, path: "/forged" } as unknown as typeof processes;

    expect(canRunQuery(forged, ["occ.read"])).toBe(false);
    expect(canRunQuery(forged, ["processes.query"])).toBe(true);
    expect(canRunCommand(forged, "start", ["occ.execute"])).toBe(false);
    expect(canRunCommand(forged, "start", ["processes.start"])).toBe(true);
    expect(canRunQuery(unknown, ["occ.read", "processes.query"])).toBe(false);
    expect(canRunCommand(unknown, "start", ["occ.execute", "processes.start"])).toBe(false);
  });

  it("shows read surfaces, protects admin surfaces, and keeps settings authenticated", () => {
    expect(visibleRoutes(["occ.read"]).map(({ path }) => path)).toEqual([
      "/overview", "/my-work", "/processes", "/interventions", "/risks",
      "/resources", "/system", "/settings",
    ]);
    expect(canAccessRoute("/domain-design", ["occ.read"])).toBe(false);
    expect(canAccessRoute("/administration", ["occ.admin"])).toBe(true);
    expect(canAccessRoute("/settings", [])).toBe(true);
  });

  it("requires exact query and command capabilities without fallback", () => {
    const processes = ROUTES.find(({ path }) => path === "/processes")!;
    expect(canRunQuery(processes, ["occ.read"])).toBe(false);
    expect(canRunQuery(processes, [processes.queryCapability])).toBe(true);
    expect(canRunCommand(processes, "start", ["occ.execute"])).toBe(false);
    expect(canRunCommand(processes, "start", ["processes.start"])).toBe(true);
    expect(canRunCommand(processes, "not-a-command", ["occ.admin"])).toBe(false);
  });

  it("default-denies every command except its exact capability", () => {
    for (const route of ROUTES) {
      for (const [operation, capability] of Object.entries(route.commandCapabilities)) {
        expect(canRunCommand(route, operation, [])).toBe(false);
        const unrelatedCapabilities = ["occ.read", "occ.execute", "occ.admin"]
          .filter((candidate) => candidate !== capability);
        expect(canRunCommand(route, operation, unrelatedCapabilities)).toBe(false);
        expect(canRunCommand(route, operation, [capability])).toBe(true);
      }
      expect(canRunCommand(route, "unknown", Object.values(route.commandCapabilities))).toBe(false);
    }
  });

  it("returns access denied before query permission and not found for unknown paths", () => {
    expect(resolveRoute("/administration", ["occ.read"])).toEqual({ kind: "access-denied", path: "/administration" });
    expect(resolveRoute("/unknown", ["occ.admin"])).toEqual({ kind: "not-found", path: "/unknown" });
  });

  it.each(["__proto__", "constructor", "toString"])("default-denies inherited registry name %s", (path) => {
    expect(routePathFromHash(`#${path}`)).toBeNull();
    expect(resolveRoute(path, ["occ.read", "occ.admin"])).toEqual({ kind: "not-found", path });
    expect(canAccessRoute(path, ["occ.read", "occ.admin"])).toBe(false);
    expect(canRunQuery(path, ["occ.read", "occ.admin"])).toBe(false);
    expect(canRunCommand(path, "start", ["processes.start"])).toBe(false);

    const target = {
      location: { hash: "#/overview" },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    expect(createHashRouter(target).set(path)).toBe(false);
    expect(target.location.hash).toBe("#/overview");
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
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(listener).toHaveBeenLastCalledWith({ path: "/risks", focusToken: 1 });
    expect(router.set("/outside")).toBe(false);
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
    disposeSecond();
  });

  it("owns duplicate callback subscriptions independently with idempotent disposal", () => {
    const handlers = new Set<() => void>();
    const target = {
      location: { hash: "#/overview" },
      addEventListener: vi.fn((_type: "hashchange", handler: () => void) => void handlers.add(handler)),
      removeEventListener: vi.fn((_type: "hashchange", handler: () => void) => void handlers.delete(handler)),
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
    for (const handler of handlers) handler();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(target.removeEventListener).not.toHaveBeenCalled();
    disposeSecond();
    disposeSecond();
    expect(target.removeEventListener).toHaveBeenCalledTimes(1);
  });
});
