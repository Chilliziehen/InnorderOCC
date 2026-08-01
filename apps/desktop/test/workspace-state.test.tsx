import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import {
  commandReceiptSchema,
  workspaceCommandSchema,
  workspaceResultSchema,
  type WorkspaceCommand,
} from "../src/desktop-contract";
import { CommandPanel } from "../src/renderer/components/CommandPanel";
import { QueryToolbar, type WorkspaceQueryValue } from "../src/renderer/components/QueryToolbar";
import { WorkspaceState } from "../src/renderer/components/WorkspaceState";
import {
  WORKSPACE_DEFINITIONS,
  commandFor,
  type WorkspaceDefinition,
} from "../src/renderer/workspaces/workspace-definitions";

const itemSchema = z.object({ id: z.string(), name: z.string() }).strict();
const fetchedAt = "2026-08-01T12:00:00.000Z";
const correlationId = "00000000-0000-4000-8000-000000000099";

describe("workspace production definitions", () => {
  it("defines and deeply freezes the nine approved workspaces plus settings", () => {
    expect(Object.keys(WORKSPACE_DEFINITIONS)).toEqual([
      "overview", "my-work", "processes", "interventions", "risks", "resources",
      "domain-design", "administration", "system", "settings",
    ]);
    for (const definition of Object.values(WORKSPACE_DEFINITIONS)) {
      expect(definition.apiGroups.length).toBeGreaterThan(0);
      expect(definition.tabs.length).toBeGreaterThan(0);
      expect(definition.columns.length).toBeGreaterThan(0);
      expect(definition.query.operation).not.toBe("");
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.apiGroups)).toBe(true);
      expect(Object.isFrozen(definition.filters)).toBe(true);
      expect(Object.isFrozen(definition.query.availability)).toBe(true);
    }
  });

  it("keeps only committed system and profile/session operations available", () => {
    const available = Object.values(WORKSPACE_DEFINITIONS).flatMap((definition) => [
      [definition.id, definition.query.operation, definition.query.availability.state],
      ...definition.commands.map((command) => [definition.id, command.operation, command.availability.state]),
    ]);
    expect(available.filter(([, , state]) => state === "available")).toEqual([
      ["system", "system.status", "available"],
      ["settings", "profiles.current", "available"],
      ["settings", "profiles.select", "available"],
      ["settings", "profiles.save", "available"],
      ["settings", "profiles.remove", "available"],
      ["settings", "session.logout", "available"],
    ]);
    for (const [, , state] of available.filter(([id]) => !["system", "settings"].includes(id!))) {
      expect(state).toBe("unavailable");
    }
  });

  it("records the exact plan resource groups and defaults forged operations to deny", () => {
    expect(WORKSPACE_DEFINITIONS["my-work"].apiGroups).toEqual([
      "/tasks", "/evidence", "/reservations", "/recommendations",
    ]);
    expect(WORKSPACE_DEFINITIONS.administration.apiGroups).toEqual([
      "/people", "/relationships", "/roles", "/policy-releases", "/providers", "/knowledge", "/audit",
    ]);
    expect(commandFor("risks", "resolve")?.capability).toBe("risks.resolve");
    expect(commandFor("risks", "forged-operation")).toBeUndefined();

    const forged = Object.create(WORKSPACE_DEFINITIONS.risks) as WorkspaceDefinition;
    Object.defineProperty(forged, "commands", { value: [{ operation: "forged-operation" }] });
    expect(commandFor(forged, "forged-operation")).toBeUndefined();
  });

  it("locks the exact operation matrix for every workspace", () => {
    const matrix = Object.fromEntries(Object.entries(WORKSPACE_DEFINITIONS).map(([id, definition]) => [id, {
      groups: definition.apiGroups,
      tabs: definition.tabs.map((tab) => tab.id),
      filters: definition.filters.map((filter) => filter.key),
      sorts: definition.sortOptions.map((sort) => sort.value),
      columns: definition.columns.map((column) => column.key),
      query: `${definition.query.operation}:${definition.query.capability}`,
      commands: definition.commands.map((entry) => `${entry.operation}:${entry.capability}`),
    }]));
    expect(matrix).toEqual({
      overview: { groups: ["/me", "/tasks", "/processes", "/risks", "/system"], tabs: ["attention", "deadlines", "risks", "health"], filters: ["severity"], sorts: ["priority-desc", "due-asc"], columns: ["item", "type", "status", "dueAt"], query: "overview.query:overview.query", commands: [] },
      "my-work": { groups: ["/tasks", "/evidence", "/reservations", "/recommendations"], tabs: ["available", "claimed", "blocked", "pending-review", "returned", "completed"], filters: ["state"], sorts: ["due-asc", "updated-desc"], columns: ["task", "process", "state", "dueAt"], query: "tasks.query:tasks.query", commands: ["claim:tasks.claim", "submitEvidence:evidence.submit", "reserve:reservations.create", "guidance:recommendations.request"] },
      processes: { groups: ["/cohorts", "/processes", "/tasks"], tabs: ["cohorts", "processes", "participants", "tasks", "timeline"], filters: ["status", "participant", "timeline"], sorts: ["updated-desc", "started-desc"], columns: ["process", "cohort", "owner", "status"], query: "processes.query:processes.query", commands: ["create:cohorts.create", "start:processes.start", "suspend:processes.suspend", "cancel:processes.cancel"] },
      interventions: { groups: ["/evidence", "/risks", "/recommendations", "/audit"], tabs: ["reviews", "exceptions", "policy", "ai"], filters: ["type", "status"], sorts: ["created-desc", "priority-desc"], columns: ["item", "type", "owner", "status"], query: "interventions.query:interventions.query", commands: ["accept:evidence.review", "conditional:evidence.review", "reject:evidence.review", "return:interventions.resolve"] },
      risks: { groups: ["/risks"], tabs: ["open", "mine", "resolved"], filters: ["severity", "sla", "owner", "status"], sorts: ["severity-desc", "updated-desc", "sla-asc"], columns: ["risk", "severity", "owner", "status"], query: "risks.query:risks.query", commands: ["acknowledge:risks.acknowledge", "assign:risks.assign", "mitigate:risks.mitigate", "escalate:risks.escalate", "resolve:risks.resolve"] },
      resources: { groups: ["/resources", "/reservations"], tabs: ["inventory", "reservations", "conflicts"], filters: ["type", "availability", "conflict"], sorts: ["name-asc", "availability-desc"], columns: ["resource", "type", "availability", "reservation"], query: "resources.query:resources.query", commands: ["create:resources.create", "change:resources.change", "reserve:reservations.create", "cancel:reservations.cancel"] },
      "domain-design": { groups: ["/packages", "/package-versions", "/policy-releases"], tabs: ["drafts", "versions", "validation", "releases"], filters: ["status", "validation"], sorts: ["updated-desc", "name-asc"], columns: ["package", "version", "validation", "status"], query: "packages.query:packages.query", commands: ["import:packages.import", "validate:packages.validate", "diff:packages.diff", "approve:packages.approve", "publish:packages.publish"] },
      administration: { groups: ["/people", "/relationships", "/roles", "/policy-releases", "/providers", "/knowledge", "/audit"], tabs: ["people", "relationships", "roles", "policies", "providers", "knowledge", "audit"], filters: ["status", "type"], sorts: ["updated-desc", "name-asc"], columns: ["subject", "type", "status", "updatedAt"], query: "administration.query:administration.query", commands: ["create:people.manage", "disable:people.manage", "assign:roles.manage", "release:policies.manage", "test:providers.manage", "ingest:knowledge.manage", "inspect:audit.query"] },
      system: { groups: ["/system", "/audit", "/events"], tabs: ["services", "dependencies", "delivery"], filters: ["state"], sorts: ["service-asc", "state-asc"], columns: ["service", "version", "state", "freshness"], query: "system.status:occ.read", commands: [] },
      settings: { groups: ["/auth", "/me"], tabs: ["profile", "trust", "preferences", "session"], filters: [], sorts: ["name-asc"], columns: ["profile", "environment", "origin", "trust"], query: "profiles.current:occ.read", commands: ["profiles.select:occ.read", "profiles.save:occ.read", "profiles.remove:occ.read", "session.logout:occ.read", "preferences.update:preferences.update"] },
    });
  });

  it("recursively freezes every metadata branch", () => {
    const assertDeepFrozen = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      expect(Object.isFrozen(value)).toBe(true);
      for (const child of Object.values(value)) assertDeepFrozen(child);
    };
    assertDeepFrozen(WORKSPACE_DEFINITIONS);
  });

  it("deeply matches every production metadata field", () => {
    const preferences = commandFor("settings", "preferences.update");
    expect(preferences?.availability).toMatchObject({ resourceGroups: ["/me"] });
    expect(WORKSPACE_DEFINITIONS).toMatchInlineSnapshot(`
      {
        "administration": {
          "apiGroups": [
            "/people",
            "/relationships",
            "/roles",
            "/policy-releases",
            "/providers",
            "/knowledge",
            "/audit",
          ],
          "columns": [
            {
              "key": "subject",
              "label": "对象",
            },
            {
              "key": "type",
              "label": "类型",
            },
            {
              "key": "status",
              "label": "状态",
            },
            {
              "key": "updatedAt",
              "label": "更新时间",
            },
          ],
          "commands": [
            {
              "availability": {
                "message": "人员创建 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/people",
                ],
                "state": "unavailable",
              },
              "capability": "people.manage",
              "label": "创建人员",
              "operation": "create",
            },
            {
              "availability": {
                "message": "人员停用 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/people",
                ],
                "state": "unavailable",
              },
              "capability": "people.manage",
              "label": "停用人员",
              "operation": "disable",
            },
            {
              "availability": {
                "message": "角色分配 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/relationships",
                  "/roles",
                ],
                "state": "unavailable",
              },
              "capability": "roles.manage",
              "label": "分配角色",
              "operation": "assign",
            },
            {
              "availability": {
                "message": "策略发布 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/policy-releases",
                ],
                "state": "unavailable",
              },
              "capability": "policies.manage",
              "label": "发布策略",
              "operation": "release",
            },
            {
              "availability": {
                "message": "智能服务测试 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/providers",
                ],
                "state": "unavailable",
              },
              "capability": "providers.manage",
              "label": "测试智能服务",
              "operation": "test",
            },
            {
              "availability": {
                "message": "知识导入 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/knowledge",
                ],
                "state": "unavailable",
              },
              "capability": "knowledge.manage",
              "label": "导入知识",
              "operation": "ingest",
            },
            {
              "availability": {
                "message": "审计查询 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/audit",
                ],
                "state": "unavailable",
              },
              "capability": "audit.query",
              "label": "检查审计",
              "operation": "inspect",
            },
          ],
          "filters": [
            {
              "key": "status",
              "label": "状态",
              "options": [
                {
                  "label": "启用",
                  "value": "active",
                },
                {
                  "label": "停用",
                  "value": "disabled",
                },
              ],
            },
            {
              "key": "type",
              "label": "类型",
              "options": [],
            },
          ],
          "id": "administration",
          "query": {
            "availability": {
              "message": "管理 API 合同尚未集成",
              "reason": "UNAVAILABLE_CONTRACT",
              "resourceGroups": [
                "/people",
                "/relationships",
                "/roles",
                "/policy-releases",
                "/providers",
                "/knowledge",
                "/audit",
              ],
              "state": "unavailable",
            },
            "capability": "administration.query",
            "label": "查询管理数据",
            "operation": "administration.query",
          },
          "sortOptions": [
            {
              "label": "最近更新",
              "value": "updated-desc",
            },
            {
              "label": "名称",
              "value": "name-asc",
            },
          ],
          "tabs": [
            {
              "id": "people",
              "label": "人员",
            },
            {
              "id": "relationships",
              "label": "关系",
            },
            {
              "id": "roles",
              "label": "角色",
            },
            {
              "id": "policies",
              "label": "策略发布",
            },
            {
              "id": "providers",
              "label": "智能服务",
            },
            {
              "id": "knowledge",
              "label": "知识",
            },
            {
              "id": "audit",
              "label": "审计",
            },
          ],
        },
        "domain-design": {
          "apiGroups": [
            "/packages",
            "/package-versions",
            "/policy-releases",
          ],
          "columns": [
            {
              "key": "package",
              "label": "领域包",
            },
            {
              "key": "version",
              "label": "版本",
            },
            {
              "key": "validation",
              "label": "校验",
            },
            {
              "key": "status",
              "label": "状态",
            },
          ],
          "commands": [
            {
              "availability": {
                "message": "领域包导入 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/packages",
                ],
                "state": "unavailable",
              },
              "capability": "packages.import",
              "label": "导入",
              "operation": "import",
            },
            {
              "availability": {
                "message": "领域包校验 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/package-versions",
                ],
                "state": "unavailable",
              },
              "capability": "packages.validate",
              "label": "校验",
              "operation": "validate",
            },
            {
              "availability": {
                "message": "版本比较 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/package-versions",
                ],
                "state": "unavailable",
              },
              "capability": "packages.diff",
              "label": "比较版本",
              "operation": "diff",
            },
            {
              "availability": {
                "message": "领域包批准 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/package-versions",
                ],
                "state": "unavailable",
              },
              "capability": "packages.approve",
              "label": "批准",
              "operation": "approve",
            },
            {
              "availability": {
                "message": "领域包发布 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/policy-releases",
                ],
                "state": "unavailable",
              },
              "capability": "packages.publish",
              "label": "发布",
              "operation": "publish",
            },
          ],
          "filters": [
            {
              "key": "status",
              "label": "状态",
              "options": [
                {
                  "label": "草稿",
                  "value": "draft",
                },
                {
                  "label": "已批准",
                  "value": "approved",
                },
                {
                  "label": "已发布",
                  "value": "published",
                },
              ],
            },
            {
              "key": "validation",
              "label": "校验结果",
              "options": [
                {
                  "label": "通过",
                  "value": "passed",
                },
                {
                  "label": "失败",
                  "value": "failed",
                },
              ],
            },
          ],
          "id": "domain-design",
          "query": {
            "availability": {
              "message": "领域包 API 合同尚未集成",
              "reason": "UNAVAILABLE_CONTRACT",
              "resourceGroups": [
                "/packages",
                "/package-versions",
                "/policy-releases",
              ],
              "state": "unavailable",
            },
            "capability": "packages.query",
            "label": "查询领域包",
            "operation": "packages.query",
          },
          "sortOptions": [
            {
              "label": "最近更新",
              "value": "updated-desc",
            },
            {
              "label": "名称",
              "value": "name-asc",
            },
          ],
          "tabs": [
            {
              "id": "drafts",
              "label": "草稿",
            },
            {
              "id": "versions",
              "label": "版本",
            },
            {
              "id": "validation",
              "label": "校验",
            },
            {
              "id": "releases",
              "label": "发布",
            },
          ],
        },
        "interventions": {
          "apiGroups": [
            "/evidence",
            "/risks",
            "/recommendations",
            "/audit",
          ],
          "columns": [
            {
              "key": "item",
              "label": "介入事项",
            },
            {
              "key": "type",
              "label": "类型",
            },
            {
              "key": "owner",
              "label": "处理人",
            },
            {
              "key": "status",
              "label": "状态",
            },
          ],
          "commands": [
            {
              "availability": {
                "message": "证据审核 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/evidence",
                ],
                "state": "unavailable",
              },
              "capability": "evidence.review",
              "label": "接受",
              "operation": "accept",
            },
            {
              "availability": {
                "message": "证据审核 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/evidence",
                ],
                "state": "unavailable",
              },
              "capability": "evidence.review",
              "label": "有条件接受",
              "operation": "conditional",
            },
            {
              "availability": {
                "message": "证据审核 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/evidence",
                ],
                "state": "unavailable",
              },
              "capability": "evidence.review",
              "label": "拒绝",
              "operation": "reject",
            },
            {
              "availability": {
                "message": "介入退回 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/evidence",
                  "/audit",
                ],
                "state": "unavailable",
              },
              "capability": "interventions.resolve",
              "label": "退回",
              "operation": "return",
            },
          ],
          "filters": [
            {
              "key": "type",
              "label": "介入类型",
              "options": [
                {
                  "label": "审核",
                  "value": "review",
                },
                {
                  "label": "异常",
                  "value": "exception",
                },
                {
                  "label": "策略",
                  "value": "policy",
                },
              ],
            },
            {
              "key": "status",
              "label": "状态",
              "options": [
                {
                  "label": "待处理",
                  "value": "open",
                },
                {
                  "label": "已处理",
                  "value": "resolved",
                },
              ],
            },
          ],
          "id": "interventions",
          "query": {
            "availability": {
              "message": "人工介入 API 合同尚未集成",
              "reason": "UNAVAILABLE_CONTRACT",
              "resourceGroups": [
                "/evidence",
                "/risks",
                "/recommendations",
                "/audit",
              ],
              "state": "unavailable",
            },
            "capability": "interventions.query",
            "label": "查询介入事项",
            "operation": "interventions.query",
          },
          "sortOptions": [
            {
              "label": "最新进入",
              "value": "created-desc",
            },
            {
              "label": "优先级",
              "value": "priority-desc",
            },
          ],
          "tabs": [
            {
              "id": "reviews",
              "label": "证据审核",
            },
            {
              "id": "exceptions",
              "label": "异常",
            },
            {
              "id": "policy",
              "label": "策略阻断",
            },
            {
              "id": "ai",
              "label": "智能建议",
            },
          ],
        },
        "my-work": {
          "apiGroups": [
            "/tasks",
            "/evidence",
            "/reservations",
            "/recommendations",
          ],
          "columns": [
            {
              "key": "task",
              "label": "任务",
            },
            {
              "key": "process",
              "label": "流程",
            },
            {
              "key": "state",
              "label": "状态",
            },
            {
              "key": "dueAt",
              "label": "时限",
            },
          ],
          "commands": [
            {
              "availability": {
                "message": "任务领取 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/tasks",
                ],
                "state": "unavailable",
              },
              "capability": "tasks.claim",
              "label": "领取任务",
              "operation": "claim",
            },
            {
              "availability": {
                "message": "证据提交 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/evidence",
                ],
                "state": "unavailable",
              },
              "capability": "evidence.submit",
              "label": "提交证据",
              "operation": "submitEvidence",
            },
            {
              "availability": {
                "message": "资源预留 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/reservations",
                ],
                "state": "unavailable",
              },
              "capability": "reservations.create",
              "label": "预留资源",
              "operation": "reserve",
            },
            {
              "availability": {
                "message": "智能建议 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/recommendations",
                ],
                "state": "unavailable",
              },
              "capability": "recommendations.request",
              "label": "请求智能建议",
              "operation": "guidance",
            },
          ],
          "filters": [
            {
              "key": "state",
              "label": "状态",
              "options": [
                {
                  "label": "可领取",
                  "value": "available",
                },
                {
                  "label": "已领取",
                  "value": "claimed",
                },
                {
                  "label": "已阻断",
                  "value": "blocked",
                },
              ],
            },
          ],
          "id": "my-work",
          "query": {
            "availability": {
              "message": "任务 API 合同尚未集成",
              "reason": "UNAVAILABLE_CONTRACT",
              "resourceGroups": [
                "/tasks",
              ],
              "state": "unavailable",
            },
            "capability": "tasks.query",
            "label": "查询我的工作",
            "operation": "tasks.query",
          },
          "sortOptions": [
            {
              "label": "最早到期",
              "value": "due-asc",
            },
            {
              "label": "最近更新",
              "value": "updated-desc",
            },
          ],
          "tabs": [
            {
              "id": "available",
              "label": "可领取",
            },
            {
              "id": "claimed",
              "label": "已领取",
            },
            {
              "id": "blocked",
              "label": "已阻断",
            },
            {
              "id": "pending-review",
              "label": "待审核",
            },
            {
              "id": "returned",
              "label": "已退回",
            },
            {
              "id": "completed",
              "label": "已完成",
            },
          ],
        },
        "overview": {
          "apiGroups": [
            "/me",
            "/tasks",
            "/processes",
            "/risks",
            "/system",
          ],
          "columns": [
            {
              "key": "item",
              "label": "事项",
            },
            {
              "key": "type",
              "label": "类型",
            },
            {
              "key": "status",
              "label": "状态",
            },
            {
              "key": "dueAt",
              "label": "时限",
            },
          ],
          "commands": [],
          "filters": [
            {
              "key": "severity",
              "label": "严重性",
              "options": [
                {
                  "label": "高",
                  "value": "high",
                },
                {
                  "label": "中",
                  "value": "medium",
                },
                {
                  "label": "低",
                  "value": "low",
                },
              ],
            },
          ],
          "id": "overview",
          "query": {
            "availability": {
              "message": "总览业务 API 合同尚未集成",
              "reason": "UNAVAILABLE_CONTRACT",
              "resourceGroups": [
                "/me",
                "/tasks",
                "/processes",
                "/risks",
              ],
              "state": "unavailable",
            },
            "capability": "overview.query",
            "label": "查询运行总览",
            "operation": "overview.query",
          },
          "sortOptions": [
            {
              "label": "优先级",
              "value": "priority-desc",
            },
            {
              "label": "最早到期",
              "value": "due-asc",
            },
          ],
          "tabs": [
            {
              "id": "attention",
              "label": "关注事项",
            },
            {
              "id": "deadlines",
              "label": "时限",
            },
            {
              "id": "risks",
              "label": "风险",
            },
            {
              "id": "health",
              "label": "服务健康",
            },
          ],
        },
        "processes": {
          "apiGroups": [
            "/cohorts",
            "/processes",
            "/tasks",
          ],
          "columns": [
            {
              "key": "process",
              "label": "流程",
            },
            {
              "key": "cohort",
              "label": "群组",
            },
            {
              "key": "owner",
              "label": "负责人",
            },
            {
              "key": "status",
              "label": "状态",
            },
          ],
          "commands": [
            {
              "availability": {
                "message": "群组创建 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/cohorts",
                ],
                "state": "unavailable",
              },
              "capability": "cohorts.create",
              "label": "创建群组",
              "operation": "create",
            },
            {
              "availability": {
                "message": "流程启动 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/processes",
                ],
                "state": "unavailable",
              },
              "capability": "processes.start",
              "label": "启动流程",
              "operation": "start",
            },
            {
              "availability": {
                "message": "流程暂停 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/processes",
                ],
                "state": "unavailable",
              },
              "capability": "processes.suspend",
              "label": "暂停流程",
              "operation": "suspend",
            },
            {
              "availability": {
                "message": "流程取消 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/processes",
                ],
                "state": "unavailable",
              },
              "capability": "processes.cancel",
              "label": "取消流程",
              "operation": "cancel",
            },
          ],
          "filters": [
            {
              "key": "status",
              "label": "状态",
              "options": [
                {
                  "label": "进行中",
                  "value": "active",
                },
                {
                  "label": "已暂停",
                  "value": "suspended",
                },
                {
                  "label": "已完成",
                  "value": "completed",
                },
              ],
            },
            {
              "key": "participant",
              "label": "参与者",
              "options": [],
            },
            {
              "key": "timeline",
              "label": "时间范围",
              "options": [
                {
                  "label": "今天",
                  "value": "today",
                },
                {
                  "label": "本周",
                  "value": "week",
                },
              ],
            },
          ],
          "id": "processes",
          "query": {
            "availability": {
              "message": "流程 API 合同尚未集成",
              "reason": "UNAVAILABLE_CONTRACT",
              "resourceGroups": [
                "/cohorts",
                "/processes",
                "/tasks",
              ],
              "state": "unavailable",
            },
            "capability": "processes.query",
            "label": "查询流程",
            "operation": "processes.query",
          },
          "sortOptions": [
            {
              "label": "最近更新",
              "value": "updated-desc",
            },
            {
              "label": "最近开始",
              "value": "started-desc",
            },
          ],
          "tabs": [
            {
              "id": "cohorts",
              "label": "群组",
            },
            {
              "id": "processes",
              "label": "流程",
            },
            {
              "id": "participants",
              "label": "参与者",
            },
            {
              "id": "tasks",
              "label": "任务",
            },
            {
              "id": "timeline",
              "label": "时间线",
            },
          ],
        },
        "resources": {
          "apiGroups": [
            "/resources",
            "/reservations",
          ],
          "columns": [
            {
              "key": "resource",
              "label": "资源",
            },
            {
              "key": "type",
              "label": "类型",
            },
            {
              "key": "availability",
              "label": "可用量",
            },
            {
              "key": "reservation",
              "label": "预留状态",
            },
          ],
          "commands": [
            {
              "availability": {
                "message": "资源创建 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/resources",
                ],
                "state": "unavailable",
              },
              "capability": "resources.create",
              "label": "创建资源",
              "operation": "create",
            },
            {
              "availability": {
                "message": "资源变更 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/resources",
                ],
                "state": "unavailable",
              },
              "capability": "resources.change",
              "label": "变更资源",
              "operation": "change",
            },
            {
              "availability": {
                "message": "资源预留 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/reservations",
                ],
                "state": "unavailable",
              },
              "capability": "reservations.create",
              "label": "创建预留",
              "operation": "reserve",
            },
            {
              "availability": {
                "message": "预留取消 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/reservations",
                ],
                "state": "unavailable",
              },
              "capability": "reservations.cancel",
              "label": "取消预留",
              "operation": "cancel",
            },
          ],
          "filters": [
            {
              "key": "type",
              "label": "资源类型",
              "options": [],
            },
            {
              "key": "availability",
              "label": "可用性",
              "options": [
                {
                  "label": "可用",
                  "value": "available",
                },
                {
                  "label": "已预留",
                  "value": "reserved",
                },
              ],
            },
            {
              "key": "conflict",
              "label": "冲突",
              "options": [
                {
                  "label": "存在冲突",
                  "value": "true",
                },
                {
                  "label": "无冲突",
                  "value": "false",
                },
              ],
            },
          ],
          "id": "resources",
          "query": {
            "availability": {
              "message": "资源 API 合同尚未集成",
              "reason": "UNAVAILABLE_CONTRACT",
              "resourceGroups": [
                "/resources",
                "/reservations",
              ],
              "state": "unavailable",
            },
            "capability": "resources.query",
            "label": "查询资源",
            "operation": "resources.query",
          },
          "sortOptions": [
            {
              "label": "名称",
              "value": "name-asc",
            },
            {
              "label": "可用量",
              "value": "availability-desc",
            },
          ],
          "tabs": [
            {
              "id": "inventory",
              "label": "资源库存",
            },
            {
              "id": "reservations",
              "label": "预留",
            },
            {
              "id": "conflicts",
              "label": "冲突",
            },
          ],
        },
        "risks": {
          "apiGroups": [
            "/risks",
          ],
          "columns": [
            {
              "key": "risk",
              "label": "风险",
            },
            {
              "key": "severity",
              "label": "严重性",
            },
            {
              "key": "owner",
              "label": "负责人",
            },
            {
              "key": "status",
              "label": "状态",
            },
          ],
          "commands": [
            {
              "availability": {
                "message": "风险确认 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/risks",
                ],
                "state": "unavailable",
              },
              "capability": "risks.acknowledge",
              "label": "确认风险",
              "operation": "acknowledge",
            },
            {
              "availability": {
                "message": "风险分派 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/risks",
                ],
                "state": "unavailable",
              },
              "capability": "risks.assign",
              "label": "分派风险",
              "operation": "assign",
            },
            {
              "availability": {
                "message": "风险缓解 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/risks",
                ],
                "state": "unavailable",
              },
              "capability": "risks.mitigate",
              "label": "记录缓解",
              "operation": "mitigate",
            },
            {
              "availability": {
                "message": "风险升级 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/risks",
                ],
                "state": "unavailable",
              },
              "capability": "risks.escalate",
              "label": "升级风险",
              "operation": "escalate",
            },
            {
              "availability": {
                "message": "风险解决 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/risks",
                ],
                "state": "unavailable",
              },
              "capability": "risks.resolve",
              "label": "解决风险",
              "operation": "resolve",
            },
          ],
          "filters": [
            {
              "key": "severity",
              "label": "严重性",
              "options": [
                {
                  "label": "严重",
                  "value": "critical",
                },
                {
                  "label": "高",
                  "value": "high",
                },
                {
                  "label": "中",
                  "value": "medium",
                },
                {
                  "label": "低",
                  "value": "low",
                },
              ],
            },
            {
              "key": "sla",
              "label": "SLA",
              "options": [
                {
                  "label": "已逾期",
                  "value": "overdue",
                },
                {
                  "label": "即将到期",
                  "value": "due-soon",
                },
              ],
            },
            {
              "key": "owner",
              "label": "负责人",
              "options": [],
            },
            {
              "key": "status",
              "label": "状态",
              "options": [
                {
                  "label": "未解决",
                  "value": "open",
                },
                {
                  "label": "已解决",
                  "value": "resolved",
                },
              ],
            },
          ],
          "id": "risks",
          "query": {
            "availability": {
              "message": "风险 API 合同尚未集成",
              "reason": "UNAVAILABLE_CONTRACT",
              "resourceGroups": [
                "/risks",
              ],
              "state": "unavailable",
            },
            "capability": "risks.query",
            "label": "查询风险",
            "operation": "risks.query",
          },
          "sortOptions": [
            {
              "label": "严重性",
              "value": "severity-desc",
            },
            {
              "label": "最近更新",
              "value": "updated-desc",
            },
            {
              "label": "SLA 时限",
              "value": "sla-asc",
            },
          ],
          "tabs": [
            {
              "id": "open",
              "label": "未解决",
            },
            {
              "id": "mine",
              "label": "我的风险",
            },
            {
              "id": "resolved",
              "label": "已解决",
            },
          ],
        },
        "settings": {
          "apiGroups": [
            "/auth",
            "/me",
          ],
          "columns": [
            {
              "key": "profile",
              "label": "配置",
            },
            {
              "key": "environment",
              "label": "环境",
            },
            {
              "key": "origin",
              "label": "服务器",
            },
            {
              "key": "trust",
              "label": "信任状态",
            },
          ],
          "commands": [
            {
              "availability": {
                "state": "available",
              },
              "capability": "occ.read",
              "label": "选择配置",
              "operation": "profiles.select",
            },
            {
              "availability": {
                "state": "available",
              },
              "capability": "occ.read",
              "label": "保存配置",
              "operation": "profiles.save",
            },
            {
              "availability": {
                "state": "available",
              },
              "capability": "occ.read",
              "label": "移除配置",
              "operation": "profiles.remove",
            },
            {
              "availability": {
                "state": "available",
              },
              "capability": "occ.read",
              "label": "退出登录",
              "operation": "session.logout",
            },
            {
              "availability": {
                "message": "个人偏好 API 合同尚未集成",
                "reason": "UNAVAILABLE_CONTRACT",
                "resourceGroups": [
                  "/me",
                ],
                "state": "unavailable",
              },
              "capability": "preferences.update",
              "label": "更新偏好",
              "operation": "preferences.update",
            },
          ],
          "filters": [],
          "id": "settings",
          "query": {
            "availability": {
              "state": "available",
            },
            "capability": "occ.read",
            "label": "读取当前配置",
            "operation": "profiles.current",
          },
          "sortOptions": [
            {
              "label": "配置名称",
              "value": "name-asc",
            },
          ],
          "tabs": [
            {
              "id": "profile",
              "label": "服务器配置",
            },
            {
              "id": "trust",
              "label": "TLS 信任",
            },
            {
              "id": "preferences",
              "label": "偏好",
            },
            {
              "id": "session",
              "label": "会话",
            },
          ],
        },
        "system": {
          "apiGroups": [
            "/system",
            "/audit",
            "/events",
          ],
          "columns": [
            {
              "key": "service",
              "label": "服务",
            },
            {
              "key": "version",
              "label": "版本",
            },
            {
              "key": "state",
              "label": "状态",
            },
            {
              "key": "freshness",
              "label": "新鲜度",
            },
          ],
          "commands": [],
          "filters": [
            {
              "key": "state",
              "label": "运行状态",
              "options": [
                {
                  "label": "就绪",
                  "value": "READY",
                },
                {
                  "label": "降级",
                  "value": "DEGRADED",
                },
                {
                  "label": "不可达",
                  "value": "UNREACHABLE",
                },
              ],
            },
          ],
          "id": "system",
          "query": {
            "availability": {
              "state": "available",
            },
            "capability": "occ.read",
            "label": "查询系统状态",
            "operation": "system.status",
          },
          "sortOptions": [
            {
              "label": "服务名称",
              "value": "service-asc",
            },
            {
              "label": "运行状态",
              "value": "state-asc",
            },
          ],
          "tabs": [
            {
              "id": "services",
              "label": "服务",
            },
            {
              "id": "dependencies",
              "label": "依赖",
            },
            {
              "id": "delivery",
              "label": "事件投递",
            },
          ],
        },
      }
    `);
  });
});

describe("canonical workspace contracts", () => {
  it.each([
    { state: "loading", label: "Loading risks" },
    { state: "ready", items: [{ id: "r-1" }], count: 1, nextCursor: "next", fetchedAt },
    { state: "empty", fetchedAt },
    { state: "error", problem: { title: "Query failed", code: "QUERY_FAILED", status: 503, correlationId } },
    { state: "stale", items: [{ id: "r-1" }], count: 1, fetchedAt },
    { state: "offline", items: [{ id: "r-1" }], count: 1, fetchedAt },
    { state: "conflict", currentVersion: 17, correlationId },
    { state: "unavailable", reason: "UNAVAILABLE_CONTRACT", resourceGroups: ["/risks"], message: "风险 API 合同尚未集成" },
  ])("validates the $state workspace result discriminant", (result) => {
    expect(workspaceResultSchema.parse(result)).toEqual(result);
  });

  it("requires a validated currentVersion on conflict command receipts", () => {
    const receipt = { state: "conflict", currentVersion: 9, correlationId };
    expect(commandReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(() => commandReceiptSchema.parse({ state: "conflict", correlationId })).toThrow();
    expect(() => commandReceiptSchema.parse({ ...receipt, currentVersion: "9" })).toThrow();
    expect(() => commandReceiptSchema.parse({ ...receipt, currentVersion: -1 })).toThrow();
  });

  it("validates exact unavailable command integration messages", () => {
    const receipt = { state: "unavailable", reason: "UNAVAILABLE_CONTRACT", resourceGroups: ["/risks"], message: "风险命令 API 合同尚未集成" };
    expect(commandReceiptSchema.parse(receipt)).toEqual(receipt);
  });

  it("accepts an intent handle and rejects renderer-generated idempotency keys", () => {
    const command = { workspace: "risks", operation: "resolve", payload: {}, intentHandle: correlationId };
    expect(workspaceCommandSchema.parse(command)).toEqual(command);
    expect(() => workspaceCommandSchema.parse({ ...command, idempotencyKey: correlationId })).toThrow();
  });
});

describe("WorkspaceState", () => {
  it("renders loading as a labelled progress region", () => {
    render(<WorkspaceState result={{ state: "loading", label: "正在加载风险" }} itemSchema={itemSchema} />);
    expect(screen.getByRole("region", { name: "正在加载风险" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("renders validated data with count, cursor, and freshness without fake records", () => {
    render(<WorkspaceState
      result={{ state: "ready", items: [{ id: "r-1", name: "供应风险" }], count: 1, nextCursor: "next", fetchedAt }}
      itemSchema={itemSchema}
      columns={[{ key: "name", label: "名称" }]}
    />);
    expect(screen.getByText("供应风险")).toBeInTheDocument();
    expect(screen.getByText("1 项")).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
    expect(screen.getByText(/下一页可用/)).toBeInTheDocument();
  });

  it("fails safely when ready records do not match the item contract", () => {
    render(<WorkspaceState
      result={{ state: "ready", items: [{ id: "r-1", secret: "raw-token" }], count: 1, fetchedAt }}
      itemSchema={itemSchema}
    />);
    expect(screen.getByRole("region", { name: "数据校验错误" })).toHaveTextContent("数据格式无效");
    expect(document.body).not.toHaveTextContent("raw-token");
  });

  it("renders empty with only a permitted next command", () => {
    const onCommand = vi.fn();
    const { rerender } = render(<WorkspaceState
      result={{ state: "empty", fetchedAt, nextCommand: { label: "创建流程", permitted: false } }}
      itemSchema={itemSchema}
      onNextCommand={onCommand}
    />);
    expect(screen.queryByRole("button", { name: "创建流程" })).not.toBeInTheDocument();
    rerender(<WorkspaceState
      result={{ state: "empty", fetchedAt, nextCommand: { label: "创建流程", permitted: true } }}
      itemSchema={itemSchema}
      onNextCommand={onCommand}
    />);
    fireEvent.click(screen.getByRole("button", { name: "创建流程" }));
    expect(onCommand).toHaveBeenCalledOnce();
  });

  it("renders a safe ProblemReceipt and retry without raw detail", () => {
    const onRetry = vi.fn();
    render(<WorkspaceState
      result={{ state: "error", problem: { title: "查询失败", detail: "token raw-secret", code: "QUERY_FAILED", status: 503, correlationId } }}
      itemSchema={itemSchema}
      onRetry={onRetry}
    />);
    const alert = screen.getByRole("region", { name: "查询错误" });
    expect(alert).toHaveTextContent("QUERY_FAILED");
    expect(alert).toHaveTextContent("503");
    expect(alert).toHaveTextContent(correlationId);
    expect(alert).not.toHaveTextContent(/raw-secret|token/);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it.each(["stale", "offline"] as const)("renders %s data age read-only outside the live region", (state) => {
    render(<WorkspaceState
      result={{ state, items: [{ id: "r-1", name: "已缓存风险" }], count: 1, fetchedAt }}
      itemSchema={itemSchema}
      now={new Date("2026-08-01T12:02:00.000Z").getTime()}
    />);
    expect(screen.getByText("已缓存风险")).toBeInTheDocument();
    expect(screen.getByText(/2 分钟/)).not.toHaveAttribute("aria-live");
    expect(screen.getAllByText(/只读/).length).toBeGreaterThan(0);
    expect(screen.getByTestId("workspace-state-announcement")).not.toHaveTextContent(/2 分钟/);
  });

  it("renders conflict version and refresh action", () => {
    const onRefresh = vi.fn();
    render(<WorkspaceState result={{ state: "conflict", currentVersion: 17, correlationId }} itemSchema={itemSchema} onRefresh={onRefresh} />);
    expect(screen.getByRole("region", { name: "版本冲突" })).toHaveTextContent(/17/);
    fireEvent.click(screen.getByRole("button", { name: "刷新当前版本" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("renders exact unavailable APIs and disabled controls", () => {
    render(<WorkspaceState
      result={{ state: "unavailable", reason: "UNAVAILABLE_CONTRACT", resourceGroups: ["/tasks", "/evidence"], message: "任务与证据 API 合同尚未集成" }}
      itemSchema={itemSchema}
      unavailableControls={["领取任务", "提交证据"]}
    />);
    expect(screen.getByLabelText("工作区合同不可用")).toHaveTextContent("UNAVAILABLE_CONTRACT");
    expect(screen.getByLabelText("工作区合同不可用")).toHaveTextContent("/tasks、/evidence");
    expect(screen.getByRole("button", { name: "领取任务" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "提交证据" })).toBeDisabled();
    expect(document.body).not.toHaveTextContent(/示例|sample/i);
  });

  it("uses one atomic live region and changes repeated transition announcements", async () => {
    const first = { state: "empty" as const, fetchedAt };
    const { rerender } = render(<WorkspaceState result={first} itemSchema={itemSchema} />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    const initial = screen.getByRole("status").textContent;
    rerender(<WorkspaceState result={{ ...first }} itemSchema={itemSchema} />);
    await waitFor(() => expect(screen.getByRole("status").textContent).not.toBe(initial));
    expect(screen.getByRole("status")).toHaveAttribute("aria-atomic", "true");
  });

  it.each([
    { state: "error" as const, problem: { title: "查询失败", code: "QUERY_FAILED", status: 503 } },
    { state: "conflict" as const, currentVersion: 17 },
  ])("keeps $state visual content out of a second live region", (result) => {
    render(<WorkspaceState result={result} itemSchema={itemSchema} />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("announces each explicit conflict refresh before invoking it", () => {
    const onRefresh = vi.fn();
    render(<WorkspaceState result={{ state: "conflict", currentVersion: 17 }} itemSchema={itemSchema} onRefresh={onRefresh} />);
    const before = screen.getByRole("status").textContent;
    fireEvent.click(screen.getByRole("button", { name: "刷新当前版本" }));
    expect(screen.getByRole("status").textContent).not.toBe(before);
    expect(screen.getByRole("status")).toHaveTextContent("正在刷新当前版本");
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});

describe("QueryToolbar", () => {
  const definition = WORKSPACE_DEFINITIONS.risks;
  const initial: WorkspaceQueryValue = { search: "", filters: {}, sort: "severity-desc" };

  it("updates controlled search, filters, sort, clear, and refresh", async () => {
    const onChange = vi.fn();
    const onRefresh = vi.fn();
    render(<QueryToolbar definition={definition} value={initial} onChange={onChange} onRefresh={onRefresh} />);
    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "逾期" } });
    fireEvent.change(screen.getByLabelText("严重性"), { target: { value: "high" } });
    fireEvent.change(screen.getByLabelText("排序"), { target: { value: "updated-desc" } });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ search: "逾期" })));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ filters: { severity: "high" } }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ sort: "updated-desc" }));
    fireEvent.click(screen.getByRole("button", { name: "清除查询条件" }));
    expect(onChange).toHaveBeenCalledWith({ search: "", filters: {}, sort: "severity-desc" });
    fireEvent.click(screen.getByRole("button", { name: "刷新" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("moves through cursors only when previous and next are present", () => {
    const onChange = vi.fn();
    const { rerender } = render(<QueryToolbar definition={definition} value={initial} onChange={onChange} onRefresh={vi.fn()} />);
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下一页" })).toBeDisabled();
    rerender(<QueryToolbar definition={definition} value={{ ...initial, cursor: "current", previousCursor: "previous", nextCursor: "next" }} onChange={onChange} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "上一页" }));
    expect(onChange).toHaveBeenCalledWith({ ...initial, cursor: "previous" });
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    expect(onChange).toHaveBeenCalledWith({ ...initial, cursor: "next" });
  });

  it("clears all cursor fields and preserves cumulative rapid query changes", () => {
    const onChange = vi.fn();
    render(<QueryToolbar
      definition={definition}
      value={{ ...initial, cursor: "current", previousCursor: "previous", nextCursor: "next" }}
      onChange={onChange}
      onRefresh={vi.fn()}
    />);
    fireEvent.change(screen.getByLabelText("搜索"), { target: { value: "逾期" } });
    fireEvent.change(screen.getByLabelText("严重性"), { target: { value: "high" } });
    fireEvent.change(screen.getByLabelText("排序"), { target: { value: "updated-desc" } });
    expect(onChange).toHaveBeenLastCalledWith({
      search: "逾期",
      filters: { severity: "high" },
      sort: "updated-desc",
    });
  });
});

describe("CommandPanel", () => {
  const command = WORKSPACE_DEFINITIONS.settings.commands.find(({ operation }) => operation === "profiles.save")!;
  const unavailableCommand = WORKSPACE_DEFINITIONS.risks.commands.find(({ operation }) => operation === "resolve")!;

  it.each([
    { name: "offline lock", props: { online: false, authenticated: true, capabilities: [command.capability] }, reason: "离线时更改操作已锁定" },
    { name: "signed out", props: { online: true, authenticated: false, capabilities: [command.capability] }, reason: "需要有效登录会话" },
    { name: "capability absent", props: { online: true, authenticated: true, capabilities: [] }, reason: `缺少能力：${command.capability}` },
  ])("blocks $name in the handler and visibly associates the reason", ({ props, reason }) => {
    const onExecute = vi.fn();
    const { container } = render(<CommandPanel workspace="settings" command={command} payload={{}} onExecute={onExecute} {...props} />);
    const button = screen.getByRole("button", { name: command.label });
    expect(button).toBeDisabled();
    const reasonNode = screen.getByText(reason);
    expect(button).toHaveAttribute("aria-describedby", reasonNode.id);
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    expect(onExecute).not.toHaveBeenCalled();
  });

  it("explains unavailable operations and rejects forced submission", () => {
    const onExecute = vi.fn();
    const { container } = render(<CommandPanel workspace="risks" command={unavailableCommand} capabilities={[unavailableCommand.capability]} online authenticated payload={{}} onExecute={onExecute} />);
    expect(unavailableCommand.availability.state).toBe("unavailable");
    if (unavailableCommand.availability.state !== "unavailable") throw new Error("test requires unavailable command");
    expect(screen.getByText(unavailableCommand.availability.message)).toBeInTheDocument();
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    expect(onExecute).not.toHaveBeenCalled();
  });

  it("default-denies a forged command descriptor", () => {
    const onExecute = vi.fn();
    const forged = { ...command, operation: "forged-operation" };
    const { container } = render(<CommandPanel workspace="settings" command={forged} capabilities={[forged.capability]} online authenticated payload={{}} onExecute={onExecute} />);
    expect(screen.getByText("未注册的操作")).toBeInTheDocument();
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    expect(onExecute).not.toHaveBeenCalled();
  });

  it("cannot forge availability for a registered unavailable operation", () => {
    const onExecute = vi.fn();
    const forged = { ...unavailableCommand, availability: { state: "available" as const } };
    const { container } = render(<CommandPanel workspace="risks" command={forged} capabilities={[forged.capability]} online authenticated payload={{}} onExecute={onExecute} />);
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    expect(onExecute).not.toHaveBeenCalled();
    expect(screen.getByText(/风险解决 API 合同尚未集成/)).toBeInTheDocument();
  });

  it("coalesces double submission under one intent handle and renders a safe receipt", async () => {
    let resolve!: (value: { state: "completed"; commandId: string; correlationId: string }) => void;
    let intent: WorkspaceCommand | undefined;
    const onExecute = vi.fn((submitted: WorkspaceCommand) => {
      intent = submitted;
      return new Promise<{ state: "completed"; commandId: string; correlationId: string }>((done) => void (resolve = done));
    });
    const { container } = render(<CommandPanel workspace="settings" command={command} capabilities={[command.capability]} online authenticated payload={{ version: 2 }} onExecute={onExecute} />);
    const form = container.querySelector("form") as HTMLFormElement;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(onExecute).toHaveBeenCalledOnce();
    expect(intent).toBeDefined();
    if (!intent) throw new Error("intent was not submitted");
    expect(intent.intentHandle).toMatch(/^[0-9a-f-]{36}$/i);
    expect(intent).not.toHaveProperty("idempotencyKey");
    expect(intent).toMatchObject({ workspace: "settings", operation: "profiles.save", payload: { version: 2 } });
    resolve({ state: "completed", commandId: "00000000-0000-4000-8000-000000000088", correlationId });
    expect(await screen.findByRole("status", { name: "命令回执" })).toHaveTextContent(correlationId);
  });

  it("reuses the same handle for an exact-payload transport retry", async () => {
    const onExecute = vi.fn()
      .mockRejectedValueOnce(new Error("token transport-secret"))
      .mockResolvedValueOnce({ state: "completed", commandId: "00000000-0000-4000-8000-000000000088", correlationId });
    const { rerender } = render(<CommandPanel workspace="settings" command={command} capabilities={[command.capability]} online authenticated payload={{ version: 2, note: "same" }} onExecute={onExecute} />);
    fireEvent.click(screen.getByRole("button", { name: command.label }));
    expect(await screen.findByRole("status", { name: "命令回执" })).toHaveTextContent("命令提交失败");
    expect(document.body).not.toHaveTextContent(/transport-secret|token/);
    rerender(<CommandPanel workspace="settings" command={command} capabilities={[command.capability]} online authenticated payload={{ note: "same", version: 2 }} onExecute={onExecute} />);
    fireEvent.click(screen.getByRole("button", { name: command.label }));
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(2));
    expect(onExecute.mock.calls[1]![0].intentHandle).toBe(onExecute.mock.calls[0]![0].intentHandle);
  });

  it("reuses the same handle after a retryable timeout receipt", async () => {
    const onExecute = vi.fn()
      .mockResolvedValueOnce({ state: "problem", problem: { title: "Timed out", code: "TIMEOUT", status: 504, retryable: true } })
      .mockResolvedValueOnce({ state: "completed", commandId: "00000000-0000-4000-8000-000000000088", correlationId });
    render(<CommandPanel workspace="settings" command={command} capabilities={[command.capability]} online authenticated payload={{ version: 2 }} onExecute={onExecute} />);
    fireEvent.click(screen.getByRole("button", { name: command.label }));
    await screen.findByText("TIMEOUT");
    fireEvent.click(screen.getByRole("button", { name: command.label }));
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(2));
    expect(onExecute.mock.calls[1]![0].intentHandle).toBe(onExecute.mock.calls[0]![0].intentHandle);
  });

  it("starts a new accepted intent when its payload is edited", async () => {
    const onExecute = vi.fn().mockResolvedValue({ state: "accepted", commandId: "00000000-0000-4000-8000-000000000088", correlationId });
    const { rerender } = render(<CommandPanel workspace="settings" command={command} capabilities={[command.capability]} online authenticated payload={{ version: 1 }} onExecute={onExecute} />);
    fireEvent.click(screen.getByRole("button", { name: command.label }));
    await screen.findByRole("status", { name: "命令回执" });
    const firstHandle = onExecute.mock.calls[0]![0].intentHandle;
    rerender(<CommandPanel workspace="settings" command={command} capabilities={[command.capability]} online authenticated payload={{ version: 2 }} onExecute={onExecute} />);
    fireEvent.click(screen.getByRole("button", { name: command.label }));
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(2));
    expect(onExecute.mock.calls[1]![0].intentHandle).not.toBe(firstHandle);
  });

  it("locks an accepted intent without exposing a manual reset", async () => {
    const onExecute = vi.fn().mockResolvedValue({ state: "accepted", commandId: "00000000-0000-4000-8000-000000000088", correlationId });
    const { container } = render(<CommandPanel workspace="settings" command={command} capabilities={[command.capability]} online authenticated payload={{ version: 2 }} onExecute={onExecute} />);
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    await screen.findByRole("status", { name: "命令回执" });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    expect(onExecute).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: command.label })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "重置命令意图" })).not.toBeInTheDocument();
  });

  it("starts a new handle after payload edits and terminal receipts", async () => {
    const onExecute = vi.fn().mockResolvedValue({ state: "completed", commandId: "00000000-0000-4000-8000-000000000088", correlationId });
    const { rerender } = render(<CommandPanel workspace="settings" command={command} capabilities={[command.capability]} online authenticated payload={{ version: 1 }} onExecute={onExecute} />);
    fireEvent.click(screen.getByRole("button", { name: command.label }));
    await waitFor(() => expect(onExecute).toHaveBeenCalledOnce());
    const firstHandle = onExecute.mock.calls[0]![0].intentHandle;
    rerender(<CommandPanel workspace="settings" command={command} capabilities={[command.capability]} online authenticated payload={{ version: 2 }} onExecute={onExecute} />);
    fireEvent.click(screen.getByRole("button", { name: command.label }));
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(2));
    expect(onExecute.mock.calls[1]![0].intentHandle).not.toBe(firstHandle);
  });

  it("shows conflict version and refreshes through the callback without raw detail", async () => {
    const onConflictRefresh = vi.fn();
    const onExecute = vi.fn().mockResolvedValue({ state: "conflict", currentVersion: 9, correlationId, detail: "token raw-secret" });
    render(<CommandPanel workspace="settings" command={command} capabilities={[command.capability]} online authenticated payload={{}} onExecute={onExecute} onConflictRefresh={onConflictRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: command.label }));
    const receipt = await screen.findByRole("status", { name: "命令回执" });
    expect(receipt).toHaveTextContent(/9/);
    expect(receipt).toHaveTextContent(correlationId);
    expect(receipt).not.toHaveTextContent(/raw-secret|token/);
    fireEvent.click(within(receipt).getByRole("button", { name: "刷新当前版本" }));
    expect(onConflictRefresh).toHaveBeenCalledOnce();
  });

  it("renders dynamic unavailable receipt reason, groups, and message", async () => {
    const onExecute = vi.fn().mockResolvedValue({
      state: "unavailable",
      reason: "UNAVAILABLE_CONTRACT",
      resourceGroups: ["/profiles", "/audit"],
      message: "Profile audit command contract is unavailable",
    });
    render(<CommandPanel workspace="settings" command={command} capabilities={[command.capability]} online authenticated payload={{}} onExecute={onExecute} />);
    fireEvent.click(screen.getByRole("button", { name: command.label }));
    const receipt = await screen.findByRole("status", { name: "命令回执" });
    expect(receipt).toHaveTextContent("UNAVAILABLE_CONTRACT");
    expect(receipt).toHaveTextContent("/profiles、/audit");
    expect(receipt).toHaveTextContent("Profile audit command contract is unavailable");
  });

  it.each(["bigint", "cycle"] as const)("cleanly blocks %s command payloads", (kind) => {
    const onExecute = vi.fn();
    const payload: Record<string, unknown> = kind === "bigint" ? { value: 1n } : {};
    if (kind === "cycle") payload.self = payload;
    const { container } = render(<CommandPanel workspace="settings" command={command} capabilities={[command.capability]} online authenticated payload={payload} onExecute={onExecute} />);
    expect(screen.getByText("命令数据必须是严格 JSON")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: command.label })).toBeDisabled();
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    expect(onExecute).not.toHaveBeenCalled();
  });
});
