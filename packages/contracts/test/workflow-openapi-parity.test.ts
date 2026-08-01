import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

import {
  ACTIVITY_KEY_PATTERN,
  blockerCodeSchema,
  COHORT_DATE_ORDER_CONSTRAINT,
  cohortStatusSchema,
  gateProviderStatusSchema,
  problemCodeSchema,
  processTimelineTypeSchema,
  STABLE_CODE_PATTERN,
  processStateSchema,
  taskTimelineTypeSchema,
  taskPresentationStateSchema,
  taskCompletionConflictCodeSchema,
  taskCompletionDependencyCodeSchema,
  taskCompletionGenericConflictProblemDetailsSchema,
  taskCompletionGenericDependencyProblemDetailsSchema,
  cohortCreationConflictProblemDetailsSchema,
  participantProcessStartConflictProblemDetailsSchema,
  processCommandConflictProblemDetailsSchema,
  processTransferConflictProblemDetailsSchema,
  processWaitReleaseConflictProblemDetailsSchema,
  taskClaimConflictProblemDetailsSchema,
  taskCommandConflictProblemDetailsSchema,
  versionedCommandConflictProblemDetailsSchema,
  workflowAuthorizationUnavailableProblemDetailsSchema,
  workflowBadRequestProblemDetailsSchema,
  workflowForbiddenProblemDetailsSchema,
  workflowInternalProblemDetailsSchema,
  workflowNotFoundProblemDetailsSchema,
  workflowRequestProblemDetailsSchema,
  workflowUnauthorizedProblemDetailsSchema,
  workflowUnavailableProblemDetailsSchema,
  workflowEventSchemas,
} from "../src/index.js";

type Schema = {
  $ref?: string;
  additionalProperties?: boolean;
  default?: unknown;
  enum?: string[];
  format?: string;
  items?: Schema;
  allOf?: Schema[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  not?: Schema;
  const?: unknown;
  maxLength?: number;
  maxItems?: number;
  maximum?: number;
  minLength?: number;
  minItems?: number;
  minimum?: number;
  pattern?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  type?: string;
  [key: `x-${string}`]: unknown;
};
type Parameter = { in?: string; name?: string; required?: boolean; schema?: Schema };
type Response = { $ref?: string; headers?: Record<string, Schema>; content?: Record<string, { schema?: Schema }> };
type Operation = {
  operationId?: string;
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, Response>;
};
type Document = {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema>; responses: Record<string, Response>; parameters: Record<string, Parameter>; headers: Record<string, Schema> };
};

let document: Document;
beforeAll(async () => {
  document = parse(await readFile(new URL("../openapi/occ-core.yaml", import.meta.url), "utf8")) as Document;
});

const dereferenceSchema = (schema: Schema): Schema => {
  if (schema.$ref === undefined) return schema;
  const name = schema.$ref.replace("#/components/schemas/", "");
  return document.components.schemas[name];
};

const expectConstraintParity = (zodSchema: Schema, openApiSchema: Schema, field: string): void => {
  const actual = dereferenceSchema(openApiSchema);
  for (const keyword of [
    "type", "format", "enum", "const", "minLength", "maxLength", "minimum", "maximum",
    "minItems", "maxItems", "pattern",
  ] as const) {
    if (keyword === "pattern" && zodSchema.format === "uuid") continue;
    if (zodSchema[keyword] !== undefined) {
      expect(actual[keyword], `${field}.${keyword}`).toEqual(zodSchema[keyword]);
    }
  }
  if (zodSchema.items !== undefined) {
    expect(actual.items, `${field}.items`).toBeDefined();
    expectConstraintParity(zodSchema.items, actual.items ?? {}, `${field}.items`);
  }
};

const operations = {
  "/api/v1/cohorts": { get: undefined, post: "CreateCohortRequest" },
  "/api/v1/cohorts/{cohortId}": { get: undefined, patch: "UpdateCohortRequest" },
  "/api/v1/cohorts/{cohortId}/members": { post: "AddCohortMemberRequest", delete: "RemoveCohortMemberRequest" },
  "/api/v1/cohorts/{cohortId}/archive": { post: "ArchiveCohortRequest" },
  "/api/v1/cohorts/{cohortId}/owner": { post: "TransferCohortOwnerRequest" },
  "/api/v1/cohorts/{cohortId}/participants/{participantId}/process": { post: "StartParticipantProcessRequest" },
  "/api/v1/processes": { get: undefined },
  "/api/v1/processes/{processId}": { get: undefined },
  "/api/v1/processes/{processId}/progress": { get: undefined },
  "/api/v1/processes/{processId}/participants": { get: undefined },
  "/api/v1/processes/{processId}/tasks": { get: undefined },
  "/api/v1/processes/{processId}/timeline": { get: undefined },
  "/api/v1/processes/{processId}/suspend": { post: "SuspendProcessRequest" },
  "/api/v1/processes/{processId}/resume": { post: "ResumeProcessRequest" },
  "/api/v1/processes/{processId}/cancel": { post: "CancelProcessRequest" },
  "/api/v1/processes/{processId}/fail": { post: "FailProcessRequest" },
  "/api/v1/processes/{processId}/transfer": { post: "TransferProcessRequest" },
  "/api/v1/processes/{processId}/reconcile": { post: "ReconcileProcessRequest" },
  "/api/v1/processes/{processId}/waits/{activityKey}/release": { post: "ReleaseProcessWaitRequest" },
  "/api/v1/tasks/my-work": { get: undefined },
  "/api/v1/tasks/{taskId}": { get: undefined },
  "/api/v1/tasks/{taskId}/history": { get: undefined },
  "/api/v1/tasks/{taskId}/blockers": { get: undefined },
  "/api/v1/tasks/{taskId}/claim": { post: "ClaimTaskRequest" },
  "/api/v1/tasks/{taskId}/complete": { post: "CompleteTaskRequest" },
  "/api/v1/tasks/{taskId}/fail": { post: "FailTaskRequest" },
  "/api/v1/me/notifications": { get: undefined },
  "/api/v1/me/notifications/{notificationId}/read": { post: "MarkNotificationReadRequest" },
  "/api/v1/events": { get: undefined },
} as const;

const commandMethods = new Set(["post", "patch", "delete"]);
const cursorOperations = new Set([
  "listCohorts", "listProcesses", "listProcessParticipants", "listProcessTasks",
  "listProcessTimeline", "listMyWork", "listTaskHistory", "listTaskBlockers",
  "listNotifications", "catchUpAuthorizedEvents",
]);
const noNotFoundOperations = new Set([
  "listCohorts", "listProcesses", "listMyWork", "listNotifications", "catchUpAuthorizedEvents",
]);
const workflowEngineOperations = new Set([
  "startParticipantProcess", "suspendProcess", "resumeProcess", "cancelProcess", "failProcess",
  "transferProcess", "reconcileProcess", "releaseProcessWait", "claimTask", "completeTask", "failTask",
]);
const conflictResponseByOperation: Record<string, string> = {
  createCohort: "CohortCreationConflict",
  updateCohort: "VersionedCommandConflict",
  addCohortMember: "VersionedCommandConflict",
  removeCohortMember: "VersionedCommandConflict",
  archiveCohort: "VersionedCommandConflict",
  transferCohortOwner: "VersionedCommandConflict",
  startParticipantProcess: "ParticipantProcessStartConflict",
  suspendProcess: "ProcessCommandConflict",
  resumeProcess: "ProcessCommandConflict",
  cancelProcess: "ProcessCommandConflict",
  failProcess: "ProcessCommandConflict",
  transferProcess: "ProcessTransferConflict",
  reconcileProcess: "ProcessCommandConflict",
  releaseProcessWait: "ProcessWaitReleaseConflict",
  claimTask: "TaskClaimConflict",
  completeTask: "TaskBlocked",
  failTask: "TaskCommandConflict",
  markNotificationRead: "VersionedCommandConflict",
};
const parametersFor = (operation: Operation): Parameter[] => operation.parameters ?? [];
const resolveParameter = (parameter: Parameter): Parameter => {
  const name = parameter.schema?.$ref?.replace("#/components/parameters/", "");
  return name ? document.components.parameters[name] : parameter;
};

describe("workflow OpenAPI surface", () => {
  it("documents every designed path and method with exact command bodies", () => {
    for (const [path, methods] of Object.entries(operations)) {
      for (const [method, requestSchema] of Object.entries(methods)) {
        const operation = document.paths[path]?.[method];
        expect(operation, `${method.toUpperCase()} ${path}`).toBeDefined();
        if (requestSchema !== undefined) {
          expect(operation.requestBody?.required).toBe(true);
          expect(operation.requestBody?.content?.["application/json"]?.schema?.$ref).toBe(`#/components/schemas/${requestSchema}`);
        } else {
          expect(operation.requestBody).toBeUndefined();
        }
      }
    }
  });

  it("requires UUID path parameters and the bounded activity key", () => {
    for (const [path, methods] of Object.entries(operations)) {
      const expected = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
      for (const method of Object.keys(methods)) {
        const actual = parametersFor(document.paths[path][method]).filter((parameter) => parameter.in === "path").map(resolveParameter);
        expect(actual.map((parameter) => parameter.name)).toEqual(expected);
        for (const parameter of actual) {
          expect(parameter.in).toBe("path");
          expect(parameter.required).toBe(true);
          if (parameter.name === "activityKey") {
            expect(parameter.schema).toEqual({ type: "string", minLength: 1, maxLength: 128, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" });
          } else {
            expect(parameter.schema).toEqual({ type: "string", format: "uuid" });
          }
        }
      }
    }
  });

  it("requires idempotency and replay headers on every workflow command", () => {
    for (const [path, methods] of Object.entries(operations)) {
      for (const method of Object.keys(methods)) {
        if (!commandMethods.has(method)) continue;
        const operation = document.paths[path][method];
        const header = parametersFor(operation).find((parameter) => parameter.name === "Idempotency-Key");
        expect(header?.in, `${method.toUpperCase()} ${path}`).toBe("header");
        expect(header?.required).toBe(true);
        expect(header?.schema).toEqual({ type: "string", minLength: 1, maxLength: 256 });
        const success = Object.entries(operation.responses ?? {}).find(([status]) => /^2\d\d$/.test(status))?.[1];
        expect(success?.headers?.["X-Idempotent-Replay"]?.$ref).toBe("#/components/headers/IdempotentReplay");
      }
    }
  });

  it("binds each operation to status-specific and operation-specific errors", () => {
    for (const [path, methods] of Object.entries(operations)) {
      for (const method of Object.keys(methods)) {
        const operation = document.paths[path][method];
        const operationId = operation.operationId ?? "";
        expect(operation.responses?.["400"]?.$ref).toBe(
          `#/components/responses/${cursorOperations.has(operationId) ? "WorkflowBadRequest" : "WorkflowRequestError"}`,
        );
        expect(operation.responses?.["401"]?.$ref).toBe("#/components/responses/WorkflowUnauthorized");
        expect(operation.responses?.["403"]?.$ref).toBe("#/components/responses/WorkflowForbidden");
        expect(operation.responses?.["500"]?.$ref).toBe("#/components/responses/WorkflowInternalError");
        expect(operation.responses?.["503"]?.$ref).toBe(
          `#/components/responses/${operationId === "completeTask" ? "TaskGateUnavailable" : workflowEngineOperations.has(operationId) ? "WorkflowUnavailable" : "WorkflowAuthorizationUnavailable"}`,
        );
        expect(operation.responses?.["404"]?.$ref).toBe(
          noNotFoundOperations.has(operationId) ? undefined : "#/components/responses/WorkflowNotFound",
        );
        const conflictResponse = conflictResponseByOperation[operationId];
        expect(operation.responses?.["409"]?.$ref).toBe(
          conflictResponse === undefined ? undefined : `#/components/responses/${conflictResponse}`,
        );
      }
    }
    expect(JSON.stringify(document.paths)).not.toContain("#/components/responses/WorkflowError");
  });
});

describe("workflow OpenAPI schema parity", () => {
  it("matches public enums and safe integer/page bounds", () => {
    expect(document.components.schemas.CohortStatus.enum).toEqual(cohortStatusSchema.options);
    expect(document.components.schemas.ProcessState.enum).toEqual(processStateSchema.options);
    expect(document.components.schemas.TaskPresentationState.enum).toEqual(taskPresentationStateSchema.options);
    expect(document.components.schemas.BlockerCode.enum).toEqual(blockerCodeSchema.options);
    expect(document.components.schemas.GateProviderStatus.enum).toEqual(gateProviderStatusSchema.options);
    expect(document.components.schemas.SafeVersion).toEqual({ type: "integer", format: "int64", minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
    expect(document.components.schemas.PageSize).toEqual({ type: "integer", minimum: 1, maximum: 100, default: 25 });
    expect(document.components.schemas.ProblemCode.enum).toEqual(problemCodeSchema.options);
    expect(document.components.schemas.ProblemDetails.properties?.code).toEqual({ $ref: "#/components/schemas/ProblemCode" });
  });

  it("keeps every reusable and operation conflict schema aligned with Zod", () => {
    const variants = {
      WorkflowRequestProblem: workflowRequestProblemDetailsSchema,
      WorkflowBadRequestProblem: workflowBadRequestProblemDetailsSchema,
      WorkflowUnauthorizedProblem: workflowUnauthorizedProblemDetailsSchema,
      WorkflowForbiddenProblem: workflowForbiddenProblemDetailsSchema,
      WorkflowNotFoundProblem: workflowNotFoundProblemDetailsSchema,
      WorkflowInternalProblem: workflowInternalProblemDetailsSchema,
      WorkflowAuthorizationUnavailableProblem: workflowAuthorizationUnavailableProblemDetailsSchema,
      WorkflowUnavailableProblem: workflowUnavailableProblemDetailsSchema,
      CohortCreationConflictProblem: cohortCreationConflictProblemDetailsSchema,
      VersionedCommandConflictProblem: versionedCommandConflictProblemDetailsSchema,
      ParticipantProcessStartConflictProblem: participantProcessStartConflictProblemDetailsSchema,
      ProcessCommandConflictProblem: processCommandConflictProblemDetailsSchema,
      ProcessTransferConflictProblem: processTransferConflictProblemDetailsSchema,
      ProcessWaitReleaseConflictProblem: processWaitReleaseConflictProblemDetailsSchema,
      TaskClaimConflictProblem: taskClaimConflictProblemDetailsSchema,
      TaskCommandConflictProblem: taskCommandConflictProblemDetailsSchema,
      TaskCompletionConflictProblem: taskCompletionGenericConflictProblemDetailsSchema,
      TaskCompletionDependencyProblem: taskCompletionGenericDependencyProblemDetailsSchema,
    };
    for (const [name, zodSchema] of Object.entries(variants)) {
      const zodJson = z.toJSONSchema(zodSchema) as Schema;
      const openApi = document.components.schemas[name].allOf?.[1];
      expect(openApi?.required, name).toEqual(["status", "code"]);
      expect(openApi?.properties?.status, `${name}.status`).toEqual({
        type: "integer", const: zodJson.properties?.status?.const,
      });
      expect(openApi?.properties?.code?.type, `${name}.code.type`).toBe("string");
      expect(openApi?.properties?.code?.const, `${name}.code.const`).toBe(zodJson.properties?.code?.const);
      expect(openApi?.properties?.code?.enum, `${name}.code.enum`).toEqual(zodJson.properties?.code?.enum);
    }
  });

  it("keeps all workflow object schemas closed with exact required fields", () => {
    const expectedRequired: Record<string, string[]> = {
      CreateCohortRequest: ["code", "name", "packageVersionId", "ownerPrincipalId", "startDate"],
      UpdateCohortRequest: ["expectedVersion"],
      AddCohortMemberRequest: ["expectedVersion", "principalId", "role"],
      RemoveCohortMemberRequest: ["expectedVersion", "principalId", "role"],
      ArchiveCohortRequest: ["expectedVersion", "reason"],
      TransferCohortOwnerRequest: ["expectedVersion", "ownerPrincipalId", "reason"],
      StartParticipantProcessRequest: ["expectedVersion"],
      SuspendProcessRequest: ["expectedVersion", "reason"],
      ResumeProcessRequest: ["expectedVersion", "reason"],
      CancelProcessRequest: ["expectedVersion", "code", "reason"],
      FailProcessRequest: ["expectedVersion", "code", "reason"],
      TransferProcessRequest: ["expectedVersion", "participantId", "reason"],
      ReconcileProcessRequest: ["expectedVersion", "reason"],
      ReleaseProcessWaitRequest: ["expectedVersion", "factType", "factId", "factVersion", "reason"],
      ClaimTaskRequest: ["expectedVersion"],
      CompleteTaskRequest: ["expectedVersion"],
      FailTaskRequest: ["expectedVersion", "code", "reason"],
      MarkNotificationReadRequest: ["expectedVersion"],
      CursorPageInfo: [],
    };
    for (const [name, required] of Object.entries(expectedRequired)) {
      const schema = document.components.schemas[name];
      expect(schema.type, name).toBe("object");
      expect(schema.additionalProperties, name).toBe(false);
      expect(schema.required ?? [], name).toEqual(required);
      expect(Object.keys(schema.properties ?? {}), name).toEqual(expect.arrayContaining(required));
    }
  });

  it("documents exact list filters and never exposes total counts", () => {
    const expectedQueries: Record<string, string[]> = {
      "/api/v1/cohorts": ["status", "packageVersionId", "updatedBefore", "cursor", "pageSize"],
      "/api/v1/processes": ["cohortId", "participantId", "state", "packageVersionId", "updatedBefore", "cursor", "pageSize"],
      "/api/v1/processes/{processId}/participants": ["cursor", "pageSize"],
      "/api/v1/processes/{processId}/tasks": ["cursor", "pageSize"],
      "/api/v1/processes/{processId}/timeline": ["cursor", "pageSize"],
      "/api/v1/tasks/my-work": ["presentationState", "processId", "cohortId", "dueBefore", "blockerCode", "updatedBefore", "cursor", "pageSize"],
      "/api/v1/tasks/{taskId}/history": ["cursor", "pageSize"],
      "/api/v1/tasks/{taskId}/blockers": ["cursor", "pageSize"],
      "/api/v1/me/notifications": ["unread", "type", "severity", "createdBefore", "cursor", "pageSize"],
      "/api/v1/events": ["cursor", "limit", "filter"],
    };
    for (const [path, names] of Object.entries(expectedQueries)) {
      const query = parametersFor(document.paths[path].get).filter((parameter) => parameter.in === "query");
      expect(query.map((parameter) => parameter.name)).toEqual(names);
      const sizeParameter = query.find((parameter) => parameter.name === (path === "/api/v1/events" ? "limit" : "pageSize"));
      expect(sizeParameter?.schema).toEqual({ type: "integer", minimum: 1, maximum: 100, default: 25 });
    }
    const eventQuery = parametersFor(document.paths["/api/v1/events"].get);
    expect(eventQuery.find((parameter) => parameter.name === "cursor")?.schema).toEqual({
      type: "string", minLength: 1, maxLength: 4096,
    });
    expect(eventQuery.find((parameter) => parameter.name === "filter")?.schema?.enum).toEqual(Object.keys(workflowEventSchemas));
    const source = JSON.stringify(document);
    expect(source).not.toMatch(/flowable/i);
    expect(source).not.toMatch(/"total"\s*:/i);
  });

  it("limits provider keys to the authorized gate-unavailable Problem Details extension", () => {
    expect(document.components.schemas.ProblemDetails.properties?.providerKeys).toBeUndefined();
    const gateProblem = document.components.schemas.TaskGateUnavailableProblem;
    expect(gateProblem.additionalProperties).toBe(false);
    expect(gateProblem.required).toEqual(["type", "title", "status", "code", "correlationId", "providerKeys"]);
    expect(gateProblem.properties?.status).toEqual({ type: "integer", const: 503 });
    expect(gateProblem.properties?.code).toEqual({ type: "string", const: "OCC_TASK_GATE_UNAVAILABLE" });
    expect(gateProblem.properties?.providerKeys).toEqual({ type: "array", minItems: 1, maxItems: 100, items: { type: "string", minLength: 1, maxLength: 128, pattern: ACTIVITY_KEY_PATTERN } });
    expect(document.components.schemas.CompleteTaskRequest.properties).toEqual({
      expectedVersion: { $ref: "#/components/schemas/SafeVersion" },
    });
  });

  it("excludes specialized completion codes from generic response branches", () => {
    expect(document.components.schemas.TaskCompletionConflictProblem).toEqual({
      allOf: [
        { $ref: "#/components/schemas/ProblemDetails" },
        {
          type: "object",
          required: ["status", "code"],
          properties: {
            status: { type: "integer", const: 409 },
            code: { type: "string", enum: taskCompletionConflictCodeSchema.options },
          },
        },
      ],
    });
    expect(document.components.schemas.TaskCompletionDependencyProblem).toEqual({
      allOf: [
        { $ref: "#/components/schemas/ProblemDetails" },
        {
          type: "object",
          required: ["status", "code"],
          properties: {
            status: { type: "integer", const: 503 },
            code: { type: "string", enum: taskCompletionDependencyCodeSchema.options },
          },
        },
      ],
    });
  });

  it("matches every stable activity, provider, form, and failure-code pattern", () => {
    const expectedActivityFields: Array<[string, Schema | undefined]> = [
      ["wait activityKey", parametersFor(document.paths["/api/v1/processes/{processId}/waits/{activityKey}/release"].post).find((parameter) => parameter.name === "activityKey")?.schema],
      ["ProcessProgress.activeActivities", document.components.schemas.ProcessProgress.properties?.activeActivities?.items],
      ["ProcessTask.activityKey", document.components.schemas.ProcessTask.properties?.activityKey],
      ["TaskBlocker.providerKey", document.components.schemas.TaskBlocker.properties?.providerKey],
      ["TaskSummary.activityKey", document.components.schemas.TaskSummary.properties?.activityKey],
      ["TaskSummary.formKey", document.components.schemas.TaskSummary.properties?.formKey],
      ["TaskDetail.activityKey", document.components.schemas.TaskDetail.properties?.activityKey],
      ["TaskDetail.formKey", document.components.schemas.TaskDetail.properties?.formKey],
      ["TaskAvailablePayload.activityKey", document.components.schemas.TaskAvailablePayload.properties?.activityKey],
      ["TaskGateUnavailableProblem.providerKeys", document.components.schemas.TaskGateUnavailableProblem.properties?.providerKeys?.items],
    ];
    for (const [field, schema] of expectedActivityFields) {
      expect(schema?.pattern, field).toBe(ACTIVITY_KEY_PATTERN);
    }
    for (const [field, schema] of [
      ["TaskSummary.failureCode", document.components.schemas.TaskSummary.properties?.failureCode],
      ["TaskDetail.failureCode", document.components.schemas.TaskDetail.properties?.failureCode],
    ] as Array<[string, Schema | undefined]>) {
      expect(schema?.pattern, field).toBe(STABLE_CODE_PATTERN);
    }
  });

  it("uses separate strict process and task history entry enums", () => {
    const processEntry = document.components.schemas.ProcessTimelineEntry;
    const taskEntry = document.components.schemas.TaskHistoryEntry;
    expect(processEntry.additionalProperties).toBe(false);
    expect(taskEntry.additionalProperties).toBe(false);
    expect(processEntry.properties?.type).toEqual({ type: "string", enum: processTimelineTypeSchema.options });
    expect(taskEntry.properties?.type).toEqual({ type: "string", enum: taskTimelineTypeSchema.options });
    expect(document.components.schemas.ProcessTimelinePage.properties?.items?.items?.$ref).toBe("#/components/schemas/ProcessTimelineEntry");
    expect(document.components.schemas.TaskHistoryPage.properties?.items?.items?.$ref).toBe("#/components/schemas/TaskHistoryEntry");
  });

  it("binds cohort update alternatives and date-order extensions to Zod", () => {
    const create = document.components.schemas.CreateCohortRequest;
    const update = document.components.schemas.UpdateCohortRequest;
    expect(create["x-occ-cross-field-constraint"]).toBe(COHORT_DATE_ORDER_CONSTRAINT);
    expect(update["x-occ-cross-field-constraint"]).toBe(COHORT_DATE_ORDER_CONSTRAINT);
    expect(update.anyOf).toEqual([
      { required: ["name"] },
      { required: ["startDate"] },
      { required: ["endDate"] },
    ]);
  });

  it("enumerates all 25 strict typed workflow event schemas", () => {
    const types = Object.keys(workflowEventSchemas);
    const eventName = (type: string) => type
      .split(/[.-]/)
      .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
      .join("");
    const expectedRefs = types.map((type) => ({ $ref: `#/components/schemas/${eventName(type)}Event` }));
    expect(document.components.schemas.WorkflowEventPage.properties?.items?.items?.oneOf).toEqual(expectedRefs);

    for (const type of types) {
      const name = eventName(type);
      const aggregateType = type.startsWith("cohort.") ? "COHORT" : type.startsWith("process.") ? "PROCESS" : "TASK";
      const aggregateIdField = `payload.${aggregateType.toLowerCase()}Id`;
      const event = document.components.schemas[`${name}Event`];
      const payload = document.components.schemas[`${name}Payload`];
      const zodEvent = workflowEventSchemas[type as keyof typeof workflowEventSchemas];
      const zodPayload = (zodEvent as unknown as {
        shape: { payload: { shape: Record<string, { isOptional: () => boolean }> } };
      }).shape.payload;
      const zodPayloadFields = Object.keys(zodPayload.shape);
      const zodRequiredFields = Object.entries(zodPayload.shape)
        .filter(([, field]) => !field.isOptional())
        .map(([field]) => field);
      expect(event.allOf?.[0]).toEqual({ $ref: "#/components/schemas/EventEnvelope" });
      expect(event.allOf?.[1]?.properties?.type).toEqual({ const: type });
      expect(event.allOf?.[1]?.properties?.schemaVersion).toEqual({ const: 1 });
      expect(event.allOf?.[1]?.properties?.aggregateType).toEqual({ const: aggregateType });
      expect(event.allOf?.[1]?.properties?.payload).toEqual({ $ref: `#/components/schemas/${name}Payload` });
      expect(event.allOf?.[1]?.required).toEqual(["type", "schemaVersion", "aggregateType", "payload"]);
      expect(zodEvent.meta()?.aggregateIdField).toBe(aggregateIdField);
      expect(event["x-occ-aggregate-id-field"]).toBe(zodEvent.meta()?.aggregateIdField);
      expect(payload.type).toBe("object");
      expect(payload.additionalProperties).toBe(false);
      expect(Object.keys(payload.properties ?? {})).toEqual(zodPayloadFields);
      expect(payload.required ?? []).toEqual(zodRequiredFields);
      const zodJsonSchema = z.toJSONSchema(zodPayload as unknown as z.ZodType) as Schema;
      for (const field of zodPayloadFields) {
        expectConstraintParity(
          zodJsonSchema.properties?.[field] ?? {},
          payload.properties?.[field] ?? {},
          `${name}Payload.${field}`,
        );
      }
    }
    expect(document.components.schemas.TaskAssigneeChangedPayload.anyOf).toEqual([
      { required: ["previousAssigneeId"] },
      { required: ["assigneeId"] },
    ]);
    for (const name of ["CohortMemberAddedPayload", "CohortMemberRemovedPayload"]) {
      expect(document.components.schemas[name].properties?.role).toEqual({
        type: "string", enum: ["TEACHER", "PARTICIPANT"],
      });
    }
  });
});
