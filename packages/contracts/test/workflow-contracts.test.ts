import { describe, expect, it } from "vitest";

import {
  addCohortMemberRequestSchema,
  archiveCohortRequestSchema,
  blockerCodeSchema,
  cancelProcessRequestSchema,
  claimTaskRequestSchema,
  cohortDetailSchema,
  cohortListQuerySchema,
  cohortPageSchema,
  cohortStatusSchema,
  completeTaskRequestSchema,
  createCohortRequestSchema,
  eventCatchUpQuerySchema,
  failProcessRequestSchema,
  failTaskRequestSchema,
  gateProviderStatusSchema,
  idempotencyKeySchema,
  markNotificationReadRequestSchema,
  notificationListQuerySchema,
  notificationPageSchema,
  processDetailSchema,
  processListQuerySchema,
  processPageSchema,
  processParticipantListQuerySchema,
  processStateSchema,
  reconcileProcessRequestSchema,
  releaseProcessWaitRequestSchema,
  removeCohortMemberRequestSchema,
  resumeProcessRequestSchema,
  safeVersionSchema,
  startParticipantProcessRequestSchema,
  suspendProcessRequestSchema,
  taskBlockerPageSchema,
  taskBlockerListQuerySchema,
  taskDetailSchema,
  taskHistoryPageSchema,
  taskHistoryQuerySchema,
  taskMyWorkQuerySchema,
  taskPageSchema,
  taskPresentationStateSchema,
  taskBlockedProblemDetailsSchema,
  taskGateUnavailableProblemDetailsSchema,
  transferCohortOwnerRequestSchema,
  transferProcessRequestSchema,
  updateCohortRequestSchema,
  workflowEventPageSchema,
  workflowErrorCodeSchema,
} from "../src/index.js";

const id = "550e8400-e29b-41d4-a716-446655440000";
const otherId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const at = "2026-08-01T12:34:56Z";

const task = {
  id,
  processId: otherId,
  cohortId: id,
  activityKey: "safety-qualification",
  activityName: "Safety qualification",
  state: "CLAIMED",
  presentationState: "CLAIMED",
  version: 3,
  assigneeId: otherId,
  formKey: "safety-checklist",
  createdAt: at,
  updatedAt: at,
} as const;

describe("workflow primitive contracts", () => {
  it("accepts every public lifecycle enum and rejects unknown values", () => {
    expect(cohortStatusSchema.options).toEqual(["DRAFT", "ACTIVE", "ARCHIVED"]);
    expect(processStateSchema.options).toEqual([
      "RUNNING", "SUSPENDED", "COMPLETED", "CANCELLED", "FAILED",
    ]);
    expect(taskPresentationStateSchema.options).toEqual([
      "AVAILABLE", "CLAIMED", "BLOCKED", "PENDING_REVIEW",
      "RETURNED", "COMPLETED", "CANCELLED", "FAILED",
    ]);
    expect(gateProviderStatusSchema.options).toEqual(["READY", "UNAVAILABLE", "STALE"]);
    expect(blockerCodeSchema.options).toEqual([
      "PREREQUISITE_UNSATISFIED", "EVIDENCE_REQUIRED", "EVIDENCE_REVIEW_PENDING",
      "EVIDENCE_RETURNED", "RESOURCE_REQUIRED", "RESOURCE_CONFLICT",
      "PROCESS_SUSPENDED", "PROCESS_CANCELLED", "POLICY_DENIED",
      "GATE_PROVIDER_UNAVAILABLE",
    ]);
  });

  it("enforces safe integer versions and page-size defaults", () => {
    expect(safeVersionSchema.parse(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => safeVersionSchema.parse(invalid)).toThrow();
    }
    expect(cohortListQuerySchema.parse({})).toEqual({ pageSize: 25 });
    expect(processListQuerySchema.parse({ pageSize: 1 })).toMatchObject({ pageSize: 1 });
    expect(taskMyWorkQuerySchema.parse({ pageSize: 100 })).toMatchObject({ pageSize: 100 });
    for (const pageSize of [0, 101, 1.5]) {
      expect(() => notificationListQuerySchema.parse({ pageSize })).toThrow();
    }
  });

  it("bounds idempotency keys", () => {
    expect(idempotencyKeySchema.parse("command-1")).toBe("command-1");
    expect(() => idempotencyKeySchema.parse("")).toThrow();
    expect(() => idempotencyKeySchema.parse("x".repeat(257))).toThrow();
  });
});

describe("cohort contracts", () => {
  it("strictly validates create, update, membership, archive, transfer, and start commands", () => {
    expect(createCohortRequestSchema.parse({
      code: "pilot-2026", name: "Pilot 2026", packageVersionId: id,
      ownerPrincipalId: otherId, startDate: "2026-08-01", endDate: "2026-12-31",
    })).toBeDefined();
    const commands = [
      [updateCohortRequestSchema, { expectedVersion: 1, name: "Renamed", endDate: null }],
      [addCohortMemberRequestSchema, { expectedVersion: 1, principalId: id, role: "PARTICIPANT" }],
      [removeCohortMemberRequestSchema, { expectedVersion: 1, principalId: id, role: "PARTICIPANT" }],
      [archiveCohortRequestSchema, { expectedVersion: 1, reason: "Pilot ended" }],
      [transferCohortOwnerRequestSchema, { expectedVersion: 1, ownerPrincipalId: id, reason: "Rotation" }],
      [startParticipantProcessRequestSchema, { expectedVersion: 1 }],
    ] as const;
    for (const [schema, value] of commands) {
      expect(schema.parse(value)).toEqual(value);
      expect(() => schema.parse({ ...value, flowableProcessDefinitionId: "secret" })).toThrow();
    }
  });

  it("strictly validates cohort detail and cursor pages without totals", () => {
    const cohort = {
      id, code: "pilot-2026", name: "Pilot 2026", packageVersionId: otherId,
      ownerPrincipalId: id, startDate: "2026-08-01", endDate: null,
      status: "DRAFT", version: 0, createdAt: at, updatedAt: at,
    } as const;
    expect(cohortDetailSchema.parse({ ...cohort, members: [] })).toBeDefined();
    expect(cohortPageSchema.parse({ items: [cohort], page: {} })).toBeDefined();
    expect(() => cohortPageSchema.parse({ items: [], page: {}, total: 0 })).toThrow();
  });
});

describe("process contracts", () => {
  it("strictly validates every process command", () => {
    const commands = [
      [suspendProcessRequestSchema, { expectedVersion: 2, reason: "Paused" }],
      [resumeProcessRequestSchema, { expectedVersion: 2, reason: "Continue" }],
      [cancelProcessRequestSchema, { expectedVersion: 2, code: "OWNER_CANCELLED", reason: "Stopped" }],
      [failProcessRequestSchema, { expectedVersion: 2, code: "WORKFLOW_FAILURE", reason: "Operator action" }],
      [transferProcessRequestSchema, { expectedVersion: 2, participantId: id, reason: "Reassigned" }],
      [reconcileProcessRequestSchema, { expectedVersion: 2, reason: "Projection check" }],
      [releaseProcessWaitRequestSchema, {
        expectedVersion: 2, factType: "PROCUREMENT_COMPLETED", factId: id,
        factVersion: 1, reason: "Parts received",
      }],
    ] as const;
    for (const [schema, value] of commands) {
      expect(schema.parse(value)).toEqual(value);
      expect(() => schema.parse({ ...value, flowableExecutionId: "hidden" })).toThrow();
    }
  });

  it("validates process details, filters, and pages without engine identifiers", () => {
    const process = {
      id, cohortId: otherId, participantId: id, startedForParticipantId: id,
      packageVersionId: otherId, state: "RUNNING", version: 4,
      startedAt: at, updatedAt: at,
    } as const;
    expect(processDetailSchema.parse(process)).toEqual(process);
    expect(processListQuerySchema.parse({ cohortId: id, participantId: otherId, state: "RUNNING" })).toBeDefined();
    expect(processPageSchema.parse({ items: [process], page: { nextCursor: "opaque" } })).toBeDefined();
    expect(() => processDetailSchema.parse({ ...process, flowableProcessInstanceId: "hidden" })).toThrow();
    expect(processParticipantListQuerySchema.parse({})).toEqual({ pageSize: 25 });
  });
});

describe("task contracts", () => {
  it("strictly validates claim, complete, and fail commands", () => {
    expect(claimTaskRequestSchema.parse({ expectedVersion: 1 })).toEqual({ expectedVersion: 1 });
    expect(completeTaskRequestSchema.parse({ expectedVersion: 1, variables: { accepted: true } })).toBeDefined();
    expect(failTaskRequestSchema.parse({ expectedVersion: 1, code: "SAFETY_FAILED", reason: "Failed gate" })).toBeDefined();
    expect(() => claimTaskRequestSchema.parse({ expectedVersion: 1, flowableTaskId: "x" })).toThrow();
  });

  it("validates task detail, work, history, and blocker pages without totals", () => {
    expect(taskDetailSchema.parse({ ...task, blockers: [] })).toBeDefined();
    expect(taskPageSchema.parse({ items: [task], page: {} })).toBeDefined();
    expect(taskHistoryPageSchema.parse({ items: [], page: {} })).toBeDefined();
    expect(taskBlockerPageSchema.parse({ items: [], page: {} })).toBeDefined();
    expect(taskHistoryQuerySchema.parse({ cursor: "opaque" })).toEqual({ cursor: "opaque", pageSize: 25 });
    expect(taskBlockerListQuerySchema.parse({ pageSize: 100 })).toEqual({ pageSize: 100 });
    expect(() => taskPageSchema.parse({ items: [], page: {}, total: 0 })).toThrow();
  });
});

describe("notification and event catch-up contracts", () => {
  it("validates notification list/read and authorized event catch-up pages", () => {
    const notification = {
      id, type: "TASK_AVAILABLE", severity: "INFO", resourceType: "TASK",
      resourceId: otherId, cursor: 1, createdAt: at,
    } as const;
    expect(notificationPageSchema.parse({ items: [notification], page: {} })).toBeDefined();
    expect(markNotificationReadRequestSchema.parse({ expectedVersion: 0 })).toEqual({ expectedVersion: 0 });
    expect(eventCatchUpQuerySchema.parse({ afterCursor: 0 })).toMatchObject({ pageSize: 25 });
    expect(workflowEventPageSchema.parse({ items: [], page: {} })).toBeDefined();
    expect(() => workflowEventPageSchema.parse({
      items: [{
        id, customerInstanceId: otherId, type: "unknown.event", schemaVersion: 1,
        aggregateType: "TASK", aggregateId: id, aggregateVersion: 1,
        occurredAt: at, correlationId: otherId, payload: {},
      }],
      page: {},
    })).toThrow();
  });
});

describe("workflow Problem Details", () => {
  const problem = {
    type: "https://innorder.example/problems/task-gate-unavailable",
    title: "Task gate unavailable",
    status: 503,
    code: "OCC_TASK_GATE_UNAVAILABLE",
    correlationId: id,
  } as const;

  it("enumerates stable workflow error codes", () => {
    expect(workflowErrorCodeSchema.parse("OCC_INVALID_REQUEST")).toBe("OCC_INVALID_REQUEST");
    expect(workflowErrorCodeSchema.parse("OCC_WORKFLOW_UNAVAILABLE")).toBe("OCC_WORKFLOW_UNAVAILABLE");
    expect(() => workflowErrorCodeSchema.parse("FLOWABLE_FAILURE")).toThrow();
  });

  it("allows provider and blocker details only in their authorized strict errors", () => {
    expect(taskGateUnavailableProblemDetailsSchema.parse({ ...problem, providerKeys: ["evidence"] })).toBeDefined();
    expect(taskBlockedProblemDetailsSchema.parse({
      ...problem,
      status: 409,
      code: "OCC_TASK_BLOCKED",
      blockerCodes: ["EVIDENCE_REQUIRED"],
    })).toBeDefined();
    expect(() => taskGateUnavailableProblemDetailsSchema.parse({ ...problem, providerKeys: ["evidence"], blockerCodes: [] })).toThrow();
  });
});
