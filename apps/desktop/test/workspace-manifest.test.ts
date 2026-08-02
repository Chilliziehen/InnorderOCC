import { describe, expect, it } from "vitest";

import { ROUTES } from "../src/renderer/routes";
import { WORKSPACE_MANIFEST } from "../src/renderer/workspace-manifest";
import { WORKSPACE_DEFINITIONS } from "../src/renderer/workspaces/workspace-definitions";
import { createMainOperationPolicy } from "../src/main-operation-policy";

const EXACT_POLICY = {
  overview: ["/overview", ["/me", "/tasks", "/processes", "/risks", "/system"], "overview.query:overview.query", []],
  "my-work": ["/my-work", ["/tasks", "/evidence", "/reservations", "/recommendations"], "tasks.query:tasks.query", ["claim:tasks.claim", "submitEvidence:evidence.submit", "reserve:reservations.create", "guidance:recommendations.request"]],
  processes: ["/processes", ["/cohorts", "/processes", "/tasks"], "processes.query:processes.query", ["create:cohorts.create", "start:processes.start", "suspend:processes.suspend", "cancel:processes.cancel"]],
  interventions: ["/interventions", ["/evidence", "/risks", "/recommendations", "/audit"], "interventions.query:interventions.query", ["accept:evidence.review", "conditional:evidence.review", "reject:evidence.review", "return:interventions.resolve"]],
  risks: ["/risks", ["/risks"], "risks.query:risks.query", ["acknowledge:risks.acknowledge", "assign:risks.assign", "mitigate:risks.mitigate", "escalate:risks.escalate", "resolve:risks.resolve"]],
  resources: ["/resources", ["/resources", "/reservations"], "resources.query:resources.query", ["create:resources.create", "change:resources.change", "reserve:reservations.create", "cancel:reservations.cancel"]],
  "domain-design": ["/domain-design", ["/packages", "/package-versions", "/policy-releases"], "packages.query:packages.query", ["import:packages.import", "validate:packages.validate", "diff:packages.diff", "approve:packages.approve", "publish:packages.publish"]],
  administration: ["/administration", ["/people", "/relationships", "/roles", "/policy-releases", "/providers", "/knowledge", "/audit"], "administration.query:administration.query", ["create:people.manage", "disable:people.manage", "assignRelationship:relationships.manage", "assign:roles.manage", "release:policies.manage", "test:providers.manage", "ingest:knowledge.manage", "inspect:audit.query"]],
  system: ["/system", ["/system", "/audit", "/events"], "system.status:occ.read", []],
  settings: ["/settings", ["/auth", "/me"], "profiles.current:occ.read", ["profiles.select:occ.read", "profiles.save:occ.read", "profiles.remove:occ.read", "session.logout:occ.read", "preferences.update:preferences.update"]],
} as const;

describe("canonical workspace manifest", () => {
  it("pins exact paths, groups, named operations, and capabilities", () => {
    const policy = Object.fromEntries(WORKSPACE_MANIFEST.map((workspace) => [workspace.id, [
      workspace.path,
      workspace.resourceGroups,
      `${workspace.query.operation}:${workspace.query.capability}`,
      workspace.commands.map((command) => `${command.operation}:${command.capability}`),
    ]]));
    expect(policy).toEqual(EXACT_POLICY);
  });

  it("owns complete frozen availability descriptors", () => {
    expect(Object.isFrozen(WORKSPACE_MANIFEST)).toBe(true);
    for (const workspace of WORKSPACE_MANIFEST) {
      expect(Object.isFrozen(workspace)).toBe(true);
      expect(Object.isFrozen(workspace.resourceGroups)).toBe(true);
      expect(Object.isFrozen(workspace.query)).toBe(true);
      expect(Object.isFrozen(workspace.query.availability)).toBe(true);
      expect(Object.isFrozen(workspace.commands)).toBe(true);
      for (const operation of [workspace.query, ...workspace.commands]) {
        if (operation.availability.state === "unavailable") {
          expect(operation.availability.reason).toBe("UNAVAILABLE_CONTRACT");
          expect(operation.availability.resourceGroups.length).toBeGreaterThan(0);
          expect(operation.availability.message.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("separates relationship and role assignment contracts", () => {
    const commands = WORKSPACE_DEFINITIONS.administration.commands;
    expect(commands.find(({ operation }) => operation === "assignRelationship")).toMatchObject({
      label: "分配关系",
      capability: "relationships.manage",
      availability: {
        state: "unavailable",
        reason: "UNAVAILABLE_CONTRACT",
        resourceGroups: ["/relationships"],
        message: "关系分配 API 合同尚未集成",
      },
    });
    expect(commands.find(({ operation }) => operation === "assign")).toMatchObject({
      label: "分配角色",
      capability: "roles.manage",
      availability: { resourceGroups: ["/roles"] },
    });
  });

  it("derives route and workspace policy with exact parity", () => {
    for (const manifest of WORKSPACE_MANIFEST) {
      const route = ROUTES.find(({ path }) => path === manifest.path)!;
      const workspace = WORKSPACE_DEFINITIONS[manifest.id];
      expect(route.queryCapability).toBe(manifest.query.capability);
      expect(route.commandCapabilities).toEqual(Object.fromEntries(manifest.commands.map((command) => [command.operation, command.capability])));
      expect(route.unavailableResourceGroups).toEqual(manifest.resourceGroups);
      expect(workspace.apiGroups).toEqual(manifest.resourceGroups);
      expect(workspace.query).toBe(manifest.query);
      expect(workspace.commands).toBe(manifest.commands);
    }
  });

  it("keeps the main generated registry in exact capability parity and production unavailable", () => {
    const production = createMainOperationPolicy(false);
    const smoke = createMainOperationPolicy(true);
    for (const workspace of WORKSPACE_MANIFEST) {
      expect(production.queryCapability(workspace.id, workspace.query.operation)).toBe(workspace.query.capability);
      expect(production.availableCommands(workspace.id)).toEqual([]);
      expect(smoke.availableCommands(workspace.id)).toEqual(workspace.commands
        .filter(({ availability }) => availability.state === "unavailable")
        .map(({ operation }) => operation));
      for (const command of workspace.commands) {
        expect(production.commandCapability(workspace.id, command.operation)).toBe(command.capability);
      }
    }
    expect(smoke.queryCapability("risks", "forged")).toBeUndefined();
    expect(smoke.commandCapability("risks", "forged")).toBeUndefined();
  });
});
