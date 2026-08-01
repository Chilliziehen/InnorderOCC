import { describe, expect, it } from "vitest";

import {
  addCohortMemberRequestSchema,
  archiveCohortRequestSchema,
  blockerCodeSchema,
  blockerSeveritySchema,
  cancelProcessRequestSchema,
  claimTaskRequestSchema,
  cohortDetailSchema,
  cohortListQuerySchema,
  cohortPageSchema,
  cohortStatusSchema,
  COHORT_DATE_ORDER_CONSTRAINT,
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
  notificationResourceTypeSchema,
  notificationSeveritySchema,
  notificationTypeSchema,
  processDetailSchema,
  processProgressSchema,
  processListQuerySchema,
  processPageSchema,
  processParticipantListQuerySchema,
  problemDetailsSchema,
  processStateSchema,
  reconcileProcessRequestSchema,
  releaseProcessWaitRequestSchema,
  removeCohortMemberRequestSchema,
  resumeProcessRequestSchema,
  safeVersionSchema,
  conditionalRuleVersionSchema,
  startParticipantProcessRequestSchema,
  suspendProcessRequestSchema,
  taskBlockerPageSchema,
  taskBlockerListQuerySchema,
  taskBlockerSchema,
  taskDetailSchema,
  taskHistoryPageSchema,
  taskHistoryQuerySchema,
  taskMyWorkQuerySchema,
  taskPageSchema,
  taskPresentationStateSchema,
  taskBlockedProblemDetailsSchema,
  taskCompletionConflictCodeSchema,
  taskCompletionConflictProblemDetailsSchema,
  taskCompletionDependencyCodeSchema,
  taskCompletionDependencyProblemDetailsSchema,
  taskGateUnavailableProblemDetailsSchema,
  cohortCreationConflictProblemDetailsSchema,
  participantProcessStartConflictProblemDetailsSchema,
  participantProcessExistsProblemDetailsSchema,
  processCommandConflictProblemDetailsSchema,
  processTransferConflictProblemDetailsSchema,
  processWaitReleaseConflictProblemDetailsSchema,
  providerKeySchema,
  taskClaimConflictProblemDetailsSchema,
  taskCommandConflictProblemDetailsSchema,
  versionedCommandConflictProblemDetailsSchema,
  staleVersionProblemDetailsSchema,
  workflowAuthorizationUnavailableProblemDetailsSchema,
  workflowBadRequestProblemDetailsSchema,
  workflowCommonProblemDetailsSchema,
  workflowForbiddenProblemDetailsSchema,
  workflowInternalProblemDetailsSchema,
  workflowNotFoundProblemDetailsSchema,
  workflowRequestProblemDetailsSchema,
  workflowUnauthorizedProblemDetailsSchema,
  workflowUnavailableProblemDetailsSchema,
  cohortCreationOperationProblemDetailsSchema,
  participantProcessStartOperationProblemDetailsSchema,
  processCommandOperationProblemDetailsSchema,
  processTransferOperationProblemDetailsSchema,
  processWaitReleaseOperationProblemDetailsSchema,
  taskClaimOperationProblemDetailsSchema,
  taskCommandOperationProblemDetailsSchema,
  taskCompletionProblemDetailsSchema,
  versionedCommandOperationProblemDetailsSchema,
  workflowDetailProblemDetailsSchema,
  workflowNestedListProblemDetailsSchema,
  workflowTopLevelListProblemDetailsSchema,
  transferCohortOwnerRequestSchema,
  transferProcessRequestSchema,
  updateCohortRequestSchema,
  workflowEventPageSchema,
  workflowErrorCodeSchema,
  problemCodeSchema,
  PLATFORM_PROBLEM_CODES,
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

  it("requires an update field and enforces the shared cohort date-order constraint", () => {
    expect(COHORT_DATE_ORDER_CONSTRAINT).toBe("endDate-gte-startDate");
    expect(() => updateCohortRequestSchema.parse({ expectedVersion: 1 })).toThrow();
    for (const update of [{ name: "Renamed" }, { startDate: "2026-08-02" }, { endDate: null }]) {
      expect(updateCohortRequestSchema.parse({ expectedVersion: 1, ...update })).toBeDefined();
    }
    expect(() => createCohortRequestSchema.parse({
      code: "pilot", name: "Pilot", packageVersionId: id, ownerPrincipalId: otherId,
      startDate: "2026-08-02", endDate: "2026-08-01",
    })).toThrow();
    expect(() => updateCohortRequestSchema.parse({
      expectedVersion: 1, startDate: "2026-08-02", endDate: "2026-08-01",
    })).toThrow();
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
    expect(completeTaskRequestSchema.parse({ expectedVersion: 1 })).toEqual({ expectedVersion: 1 });
    expect(() => completeTaskRequestSchema.parse({ expectedVersion: 1, variables: { accepted: true } })).toThrow();
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

  it("applies stable key and failure-code patterns to every task field", () => {
    expect(blockerSeveritySchema.options).toEqual(["SOFT", "HARD"]);
    expect(taskBlockerSchema.parse({
      id, code: "EVIDENCE_REQUIRED", severity: "SOFT", sourceType: "EVIDENCE", createdAt: at,
    })).toBeDefined();
    expect(() => taskBlockerSchema.parse({
      id, code: "EVIDENCE_REQUIRED", severity: "INFO", sourceType: "EVIDENCE", createdAt: at,
    })).toThrow();
    expect(conditionalRuleVersionSchema.parse("conditional.v1+published")).toBe("conditional.v1+published");
    for (const invalid of ["", "conditional rule", 1, "x".repeat(129)]) {
      expect(() => conditionalRuleVersionSchema.parse(invalid)).toThrow();
    }
    expect(taskDetailSchema.parse({
      ...task, conditionalRuleVersion: "conditional.v1+published", blockers: [],
    })).toBeDefined();
    expect(() => processProgressSchema.parse({
      processId: id, state: "RUNNING", completedActivities: 0,
      activeActivities: ["Invalid Activity"], version: 1, updatedAt: at,
    })).toThrow();
    expect(() => taskBlockerSchema.parse({
      id, code: "GATE_PROVIDER_UNAVAILABLE", severity: "HARD", sourceType: "PROVIDER",
      providerKey: "Invalid Provider", createdAt: at,
    })).toThrow();
    expect(() => taskDetailSchema.parse({ ...task, activityKey: "Invalid Activity", blockers: [] })).toThrow();
    expect(() => taskDetailSchema.parse({ ...task, formKey: "Invalid Form", blockers: [] })).toThrow();
    expect(() => taskDetailSchema.parse({ ...task, failureCode: "invalid-code", blockers: [] })).toThrow();
  });
});

describe("notification and event catch-up contracts", () => {
  it("validates notification list/read and authorized event catch-up pages", () => {
    const notification = {
      id, type: "task.available", severity: "CRITICAL", resourceType: "task",
      resourceId: otherId, cursor: 1, version: 0, createdAt: at,
    } as const;
    expect(notificationPageSchema.parse({ items: [notification], page: {} })).toBeDefined();
    expect(notificationSeveritySchema.options).toEqual(["INFO", "WARNING", "CRITICAL"]);
    for (const resourceType of ["cohort", "process", "task", "evidence.record"]) {
      expect(notificationResourceTypeSchema.parse(resourceType)).toBe(resourceType);
    }
    for (const invalid of ["TASK_AVAILABLE", "task available", "Task.Available"]) {
      expect(() => notificationTypeSchema.parse(invalid)).toThrow();
    }
    expect(() => notificationPageSchema.parse({
      items: [{ ...notification, severity: "ERROR" }], page: {},
    })).toThrow();
    expect(() => notificationPageSchema.parse({
      items: [{ ...notification, resourceType: "TASK" }], page: {},
    })).toThrow();
    const { version: _version, ...unversionedNotification } = notification;
    expect(() => notificationPageSchema.parse({ items: [unversionedNotification], page: {} })).toThrow();
    expect(notificationListQuerySchema.parse({
      type: "task.available", severity: "CRITICAL",
    })).toEqual({ type: "task.available", severity: "CRITICAL", pageSize: 25 });
    expect(() => notificationListQuerySchema.parse({ type: "TASK_AVAILABLE" })).toThrow();
    expect(markNotificationReadRequestSchema.parse({ expectedVersion: 0 })).toEqual({ expectedVersion: 0 });
    expect(eventCatchUpQuerySchema.parse({})).toEqual({ limit: 25 });
    expect(eventCatchUpQuerySchema.parse({ cursor: "opaque", limit: 100, filter: "task.completed" })).toEqual({
      cursor: "opaque", limit: 100, filter: "task.completed",
    });
    for (const invalid of [{ afterCursor: 0 }, { pageSize: 25 }, { filter: "unknown.event" }]) {
      expect(() => eventCatchUpQuerySchema.parse(invalid)).toThrow();
    }
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

  it("restricts base Problem Details to compatible platform, auth, and workflow codes", () => {
    for (const code of [
      "OCC-API-VALIDATION",
      "OCC-AUTH-INVALID-CREDENTIALS",
      "OCC-COMMAND-OPTIMISTIC-CONFLICT",
      "OCC_TASK_BLOCKED",
    ]) expect(problemCodeSchema.parse(code)).toBe(code);
    expect(PLATFORM_PROBLEM_CODES).not.toContain("AUTH_INVALID_CREDENTIALS");
    expect(PLATFORM_PROBLEM_CODES).not.toContain("UNICODE_DETAIL");
    expect(() => problemCodeSchema.parse("ARBITRARY_ERROR")).toThrow();
  });

  it("allows provider and blocker details only in their authorized strict errors", () => {
    for (const providerKey of ["evidence", "evidence.record", "resource_reservation"]) {
      expect(providerKeySchema.parse(providerKey)).toBe(providerKey);
      expect(taskGateUnavailableProblemDetailsSchema.parse({
        ...problem, providerKeys: [providerKey],
      })).toBeDefined();
    }
    expect(taskBlockedProblemDetailsSchema.parse({
      ...problem,
      status: 409,
      code: "OCC_TASK_BLOCKED",
      blockerCodes: ["EVIDENCE_REQUIRED"],
    })).toBeDefined();
    expect(() => taskGateUnavailableProblemDetailsSchema.parse({ ...problem, providerKeys: ["evidence"], blockerCodes: [] })).toThrow();
    for (const providerKey of ["", ".evidence", "Evidence", "Invalid Provider", "x".repeat(65)]) {
      expect(() => providerKeySchema.parse(providerKey)).toThrow();
      expect(() => taskGateUnavailableProblemDetailsSchema.parse({
        ...problem, providerKeys: [providerKey],
      })).toThrow();
    }
  });

  it("binds reusable workflow problems to their HTTP status and code set", () => {
    const cases = [
      [workflowBadRequestProblemDetailsSchema, 400, "OCC_INVALID_CURSOR"],
      [workflowUnauthorizedProblemDetailsSchema, 401, "OCC_UNAUTHENTICATED"],
      [workflowForbiddenProblemDetailsSchema, 403, "OCC_FORBIDDEN"],
      [workflowNotFoundProblemDetailsSchema, 404, "OCC_NOT_FOUND"],
      [workflowInternalProblemDetailsSchema, 500, "OCC_INTERNAL_ERROR"],
      [workflowUnavailableProblemDetailsSchema, 503, "OCC_WORKFLOW_UNAVAILABLE"],
    ] as const;
    for (const [schema, status, code] of cases) {
      const value = { ...problem, status, code };
      expect(schema.parse(value)).toEqual(value);
      expect(workflowCommonProblemDetailsSchema.parse(value)).toEqual(value);
      expect(() => schema.parse({ ...value, status: status + 1 })).toThrow();
      expect(() => schema.parse({ ...value, code: "OCC_TASK_BLOCKED" })).toThrow();
    }
    expect(workflowRequestProblemDetailsSchema.parse({
      ...problem, status: 400, code: "OCC_INVALID_REQUEST",
    })).toBeDefined();
    expect(() => workflowRequestProblemDetailsSchema.parse({
      ...problem, status: 400, code: "OCC_INVALID_CURSOR",
    })).toThrow();
    expect(workflowAuthorizationUnavailableProblemDetailsSchema.parse({
      ...problem, code: "OCC_AUTHORIZATION_UNAVAILABLE",
    })).toBeDefined();
    expect(() => workflowAuthorizationUnavailableProblemDetailsSchema.parse({
      ...problem, code: "OCC_WORKFLOW_UNAVAILABLE",
    })).toThrow();
  });

  it("binds conflict codes to the operation that can emit them", () => {
    const cases = [
      [cohortCreationConflictProblemDetailsSchema, "OCC_DUPLICATE_COHORT_CODE", "OCC_STALE_VERSION"],
      [versionedCommandConflictProblemDetailsSchema, "OCC_IDEMPOTENCY_CONFLICT", "OCC_CLAIM_CONFLICT"],
      [participantProcessStartConflictProblemDetailsSchema, "OCC_INVALID_TRANSITION", "OCC_CLAIM_CONFLICT"],
      [processCommandConflictProblemDetailsSchema, "OCC_PROCESS_NOT_RUNNING", "OCC_WAIT_NOT_ACTIVE"],
      [processTransferConflictProblemDetailsSchema, "OCC_PROCESS_NOT_RUNNING", "OCC_WAIT_NOT_ACTIVE"],
      [processWaitReleaseConflictProblemDetailsSchema, "OCC_WAIT_NOT_ACTIVE", "OCC_CLAIM_CONFLICT"],
      [taskClaimConflictProblemDetailsSchema, "OCC_CLAIM_CONFLICT", "OCC_WAIT_NOT_ACTIVE"],
      [taskCommandConflictProblemDetailsSchema, "OCC_INVALID_TRANSITION", "OCC_CLAIM_CONFLICT"],
    ] as const;
    for (const [schema, code, unrelatedCode] of cases) {
      expect(schema.parse({ ...problem, status: 409, code })).toBeDefined();
      expect(() => schema.parse({ ...problem, status: 503, code })).toThrow();
      expect(() => schema.parse({ ...problem, status: 409, code: unrelatedCode })).toThrow();
    }
  });

  it("requires recovery fields only on their specialized conflict variants", () => {
    const stale = { ...problem, status: 409, code: "OCC_STALE_VERSION" } as const;
    expect(() => problemDetailsSchema.parse(stale)).toThrow();
    for (const schema of [
      staleVersionProblemDetailsSchema,
      versionedCommandConflictProblemDetailsSchema,
      participantProcessStartConflictProblemDetailsSchema,
      processCommandConflictProblemDetailsSchema,
      processTransferConflictProblemDetailsSchema,
      processWaitReleaseConflictProblemDetailsSchema,
      taskClaimConflictProblemDetailsSchema,
      taskCommandConflictProblemDetailsSchema,
      taskCompletionConflictProblemDetailsSchema,
      versionedCommandOperationProblemDetailsSchema,
      participantProcessStartOperationProblemDetailsSchema,
      processCommandOperationProblemDetailsSchema,
      processTransferOperationProblemDetailsSchema,
      processWaitReleaseOperationProblemDetailsSchema,
      taskClaimOperationProblemDetailsSchema,
      taskCommandOperationProblemDetailsSchema,
      taskCompletionProblemDetailsSchema,
    ]) {
      expect(() => schema.parse(stale)).toThrow();
      expect(schema.parse({ ...stale, currentVersion: 7 })).toBeDefined();
      expect(() => schema.parse({ ...stale, currentVersion: -1 })).toThrow();
    }

    const existing = { ...problem, status: 409, code: "OCC_PARTICIPANT_PROCESS_EXISTS" } as const;
    expect(() => problemDetailsSchema.parse(existing)).toThrow();
    for (const schema of [
      participantProcessExistsProblemDetailsSchema,
      participantProcessStartConflictProblemDetailsSchema,
      processTransferConflictProblemDetailsSchema,
      participantProcessStartOperationProblemDetailsSchema,
      processTransferOperationProblemDetailsSchema,
    ]) {
      expect(() => schema.parse(existing)).toThrow();
      expect(() => schema.parse({ ...existing, existingProcessId: "not-a-uuid" })).toThrow();
      expect(schema.parse({ ...existing, existingProcessId: otherId })).toBeDefined();
    }

    expect(versionedCommandConflictProblemDetailsSchema.parse({
      ...problem, status: 409, code: "OCC_IDEMPOTENCY_CONFLICT",
    })).toBeDefined();
    expect(participantProcessStartConflictProblemDetailsSchema.parse({
      ...problem, status: 409, code: "OCC_INVALID_TRANSITION",
    })).toBeDefined();
  });

  it("exports complete status-discriminated error contracts per operation family", () => {
    expect(workflowTopLevelListProblemDetailsSchema.parse({
      ...problem, status: 400, code: "OCC_INVALID_CURSOR",
    })).toBeDefined();
    expect(() => workflowTopLevelListProblemDetailsSchema.parse({
      ...problem, status: 404, code: "OCC_NOT_FOUND",
    })).toThrow();
    expect(workflowNestedListProblemDetailsSchema.parse({
      ...problem, status: 404, code: "OCC_NOT_FOUND",
    })).toBeDefined();
    expect(workflowDetailProblemDetailsSchema.parse({
      ...problem, status: 404, code: "OCC_NOT_FOUND",
    })).toBeDefined();
    const cases = [
      [cohortCreationOperationProblemDetailsSchema, "OCC_DUPLICATE_COHORT_CODE"],
      [versionedCommandOperationProblemDetailsSchema, "OCC_IDEMPOTENCY_CONFLICT"],
      [participantProcessStartOperationProblemDetailsSchema, "OCC_INVALID_TRANSITION"],
      [processCommandOperationProblemDetailsSchema, "OCC_PROCESS_NOT_RUNNING"],
      [processTransferOperationProblemDetailsSchema, "OCC_PROCESS_NOT_RUNNING"],
      [processWaitReleaseOperationProblemDetailsSchema, "OCC_WAIT_NOT_ACTIVE"],
      [taskClaimOperationProblemDetailsSchema, "OCC_CLAIM_CONFLICT"],
      [taskCommandOperationProblemDetailsSchema, "OCC_INVALID_TRANSITION"],
    ] as const;
    for (const [schema, code] of cases) {
      expect(schema.parse({ ...problem, status: 409, code })).toBeDefined();
      expect(() => schema.parse({ ...problem, status: 409, code: "OCC_TASK_BLOCKED" })).toThrow();
    }
    expect(taskCompletionProblemDetailsSchema.parse({
      ...problem, status: 409, code: "OCC_TASK_BLOCKED", blockerCodes: ["EVIDENCE_REQUIRED"],
    })).toBeDefined();
    expect(taskCompletionProblemDetailsSchema.parse({
      ...problem, providerKeys: ["evidence"],
    })).toBeDefined();
  });

  it("requires specialized fields in completion response unions", () => {
    expect(() => taskCompletionConflictProblemDetailsSchema.parse({
      ...problem, status: 409, code: "OCC_TASK_BLOCKED",
    })).toThrow();
    expect(() => taskCompletionDependencyProblemDetailsSchema.parse(problem)).toThrow();
    expect(taskCompletionConflictProblemDetailsSchema.parse({
      ...problem, status: 409, code: "OCC_TASK_BLOCKED", blockerCodes: ["EVIDENCE_REQUIRED"],
    })).toBeDefined();
    expect(taskCompletionDependencyProblemDetailsSchema.parse({
      ...problem, providerKeys: ["evidence"],
    })).toBeDefined();
    expect(taskCompletionConflictProblemDetailsSchema.parse({
      ...problem, status: 409, code: "OCC_STALE_VERSION", currentVersion: 7,
    })).toBeDefined();
    expect(taskCompletionDependencyProblemDetailsSchema.parse({
      ...problem, code: "OCC_WORKFLOW_UNAVAILABLE",
    })).toBeDefined();
  });

  it("allows only status-specific generic completion codes", () => {
    expect(taskCompletionConflictCodeSchema.options).toEqual([
      "OCC_IDEMPOTENCY_CONFLICT",
      "OCC_INVALID_TRANSITION",
      "OCC_PROCESS_NOT_RUNNING",
    ]);
    expect(taskCompletionDependencyCodeSchema.options).toEqual([
      "OCC_AUTHORIZATION_UNAVAILABLE",
      "OCC_WORKFLOW_UNAVAILABLE",
    ]);
    for (const code of [...taskCompletionDependencyCodeSchema.options, "OCC_TASK_BLOCKED", "OCC_TASK_GATE_UNAVAILABLE"] as const) {
      expect(() => taskCompletionConflictProblemDetailsSchema.parse({
        ...problem, status: 409, code,
      })).toThrow();
    }
    for (const code of [...taskCompletionConflictCodeSchema.options, "OCC_TASK_BLOCKED", "OCC_TASK_GATE_UNAVAILABLE"] as const) {
      expect(() => taskCompletionDependencyProblemDetailsSchema.parse({
        ...problem, status: 503, code,
      })).toThrow();
    }
  });
});
