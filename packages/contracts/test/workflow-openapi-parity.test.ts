import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  blockerCodeSchema,
  cohortStatusSchema,
  gateProviderStatusSchema,
  processStateSchema,
  taskPresentationStateSchema,
} from "../src/index.js";

type Schema = {
  $ref?: string;
  additionalProperties?: boolean;
  default?: unknown;
  enum?: string[];
  format?: string;
  items?: Schema;
  maxLength?: number;
  maximum?: number;
  minLength?: number;
  minimum?: number;
  properties?: Record<string, Schema>;
  required?: string[];
  type?: string;
};
type Parameter = { in?: string; name?: string; required?: boolean; schema?: Schema };
type Response = { $ref?: string; headers?: Record<string, Schema>; content?: Record<string, { schema?: Schema }> };
type Operation = {
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

const errorStatuses = ["400", "401", "403", "404", "409", "503", "500"];
const commandMethods = new Set(["post", "patch", "delete"]);
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

  it("uses Problem Details for the complete workflow error matrix", () => {
    for (const [path, methods] of Object.entries(operations)) {
      for (const method of Object.keys(methods)) {
        const operation = document.paths[path][method];
        expect(Object.keys(operation.responses ?? {})).toEqual(expect.arrayContaining(errorStatuses));
        for (const status of errorStatuses) {
          const response = operation.responses?.[status];
          const component = response?.$ref?.replace("#/components/responses/", "");
          const resolved = component ? document.components.responses[component] : response;
          expect(resolved?.content?.["application/problem+json"]?.schema?.$ref).toBe("#/components/schemas/ProblemDetails");
        }
      }
    }
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
      "/api/v1/events": ["afterCursor", "cursor", "pageSize"],
    };
    for (const [path, names] of Object.entries(expectedQueries)) {
      const query = parametersFor(document.paths[path].get).filter((parameter) => parameter.in === "query");
      expect(query.map((parameter) => parameter.name)).toEqual(names);
      expect(query.find((parameter) => parameter.name === "pageSize")?.schema).toEqual({ type: "integer", minimum: 1, maximum: 100, default: 25 });
    }
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
    expect(gateProblem.properties?.providerKeys).toEqual({ type: "array", minItems: 1, maxItems: 100, items: { type: "string", minLength: 1, maxLength: 128 } });
    expect(document.components.schemas.CompleteTaskRequest.properties?.variables).toEqual({
      type: "object",
      propertyNames: { minLength: 1, maxLength: 128 },
      additionalProperties: {
        oneOf: [
          { type: "string", maxLength: 4096 },
          { type: "number" },
          { type: "boolean" },
          { type: "null" },
        ],
      },
    });
  });
});
