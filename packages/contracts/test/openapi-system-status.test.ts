import { readFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  ComponentStatusSchema,
  ServiceStateSchema,
  SystemStatusSchema,
  currentUserSchema,
  eventEnvelopeSchema,
  loginRequestSchema,
  problemDetailsSchema,
  refreshRequestSchema,
  tokenResponseSchema,
} from "../src/index.js";
import {
  ACCESS_TOKEN_MAX_LENGTH,
  ACCESS_TOKEN_MIN_LENGTH,
  CAPABILITY_MAX_LENGTH,
  CAPABILITY_MIN_LENGTH,
  CURRENT_USER_DISPLAY_NAME_MAX_LENGTH,
  CURRENT_USER_DISPLAY_NAME_MIN_LENGTH,
  CURRENT_USER_USERNAME_MAX_LENGTH,
  CURRENT_USER_USERNAME_MIN_LENGTH,
  EXPIRES_IN_MAX_SECONDS,
  EXPIRES_IN_MIN_SECONDS,
  LOGIN_PASSWORD_MAX_CODE_POINTS,
  LOGIN_PASSWORD_MIN_CODE_POINTS,
  LOGIN_USERNAME_MAX_LENGTH,
  LOGIN_USERNAME_MIN_LENGTH,
  LOGIN_USERNAME_PATTERN,
  REFRESH_TOKEN_LENGTH,
  REFRESH_TOKEN_PATTERN,
} from "../src/auth.js";
import {
  EVENT_AGGREGATE_TYPE_MAX_LENGTH,
  EVENT_AGGREGATE_TYPE_MIN_LENGTH,
  EVENT_AGGREGATE_VERSION_MAX,
  EVENT_AGGREGATE_VERSION_MIN,
  EVENT_OCCURRED_AT_PATTERN,
  EVENT_SCHEMA_VERSION_MAX,
  EVENT_SCHEMA_VERSION_MIN,
  EVENT_TYPE_MAX_LENGTH,
  EVENT_TYPE_MIN_LENGTH,
} from "../src/events.js";
import {
  availabilityWindowPageSchema,
  availabilityWindowSchema,
  cancelReservationRequestSchema,
  changeReservationRequestSchema,
  createAvailabilityWindowRequestSchema,
  createEvidenceUploadSessionRequestSchema,
  createRiskAdjudicationRequestSchema,
  domainProblemDetailsSchema,
  evidenceContentResultSchema,
  evidenceDownloadMetadataSchema,
  evidenceEventPayloadSchema,
  evidenceMetadataSchema,
  evidencePreviewMetadataSchema,
  evidenceRequirementPageSchema,
  evidenceRequirementSchema,
  evidenceReviewConditionSchema,
  evidenceReviewPageSchema,
  evidenceReviewSchema,
  evidenceUploadSessionSchema,
  evidenceVersionPageSchema,
  evidenceVersionSchema,
  halfOpenIntervalSchema,
  interventionItemSchema,
  interventionPageSchema,
  managedResourcePageSchema,
  managedResourceSchema,
  reservationAvailabilityRequestSchema,
  reservationAvailabilitySchema,
  reservationConflictSchema,
  reservationEventPayloadSchema,
  reservationSchedulePageSchema,
  reservationSchema,
  reserveResourceRequestSchema,
  reviewEvidenceRequestSchema,
  riskActionPageSchema,
  riskActionSchema,
  riskAdjudicationPageSchema,
  riskAdjudicationSchema,
  riskEventPayloadSchema,
  riskMetricsSchema,
  riskEvaluationSummarySchema,
  riskPageSchema,
  riskSchema,
  resourceEventPayloadSchema,
  submitEvidenceRequestSchema,
  updateResourceRequestSchema,
} from "../src/evidence-risk-resource.js";
import {
  OCC_PROBLEM_CODES,
  PROBLEM_DETAIL_MIN_LENGTH,
  PROBLEM_DETAIL_MAX_LENGTH,
  PROBLEM_STATUS_MAX,
  PROBLEM_STATUS_MIN,
  PROBLEM_TITLE_MAX_LENGTH,
  PROBLEM_TITLE_MIN_LENGTH,
} from "../src/problem-details.js";

interface OpenApiSchema extends OpenApiSchemaProperty {
  additionalProperties?: boolean;
  properties?: Record<string, OpenApiSchemaProperty>;
  required?: string[];
}

interface OpenApiSchemaProperty {
  $ref?: string;
  additionalProperties?: boolean;
  const?: string;
  discriminator?: { mapping?: Record<string, string>; propertyName?: string };
  enum?: string[];
  format?: string;
  items?: OpenApiSchemaProperty;
  maxLength?: number;
  maximum?: number;
  minLength?: number;
  minimum?: number;
  oneOf?: OpenApiSchemaProperty[];
  pattern?: string;
  type?: string;
}

interface OpenApiParameter {
  $ref?: string;
  in?: string;
  name?: string;
  required?: boolean;
}

interface OpenApiDocument {
  components: {
    headers?: Record<string, unknown>;
    parameters?: Record<string, OpenApiParameter>;
    responses?: Record<string, OpenApiResponse>;
    securitySchemes?: Record<string, unknown>;
    schemas: Record<string, OpenApiSchema>;
  };
  paths: Record<string, OpenApiPathItem>;
  security?: Array<Record<string, string[]>>;
}

interface OpenApiPathItem {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
}

interface OpenApiOperation {
  parameters?: OpenApiParameter[];
  requestBody?: {
    content?: Record<string, { schema?: { $ref?: string } }>;
  };
  security?: Array<Record<string, string[]>>;
  responses?: Record<string, OpenApiResponse>;
}

interface OpenApiResponse {
  content?: Record<string, { schema?: { $ref?: string } }>;
  headers?: Record<string, unknown>;
  $ref?: string;
}

const requiredKeys = (
  shape: Record<string, { isOptional: () => boolean }>,
): string[] =>
  Object.entries(shape)
    .filter(([, schema]) => !schema.isOptional())
    .map(([key]) => key);

const HTTP_METHODS = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
  "trace",
]);

const createOpenApiSchemaValidator = (
  schemas: Record<string, OpenApiSchema>,
  schemaName: string,
) => {
  const rewrittenSchemas = JSON.parse(
    JSON.stringify(schemas).replaceAll(
      "#/components/schemas/",
      "#/$defs/",
    ),
  ) as Record<string, unknown>;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile({
    $ref: `#/$defs/${schemaName}`,
    $defs: rewrittenSchemas,
  });
};

const expectStrictObjectParity = (
  openApiSchema: OpenApiSchema | undefined,
  zodShape: Record<string, { isOptional: () => boolean }>,
  label?: string,
): void => {
  expect(openApiSchema?.type, label).toBe("object");
  expect(openApiSchema?.additionalProperties, label).toBe(false);
  expect(openApiSchema?.required ?? [], label).toEqual(requiredKeys(zodShape));
  expect(Object.keys(openApiSchema?.properties ?? {}), label).toEqual(
    Object.keys(zodShape),
  );
};

describe("OCC Core OpenAPI system status", () => {
  it("exposes the SystemStatus schema from the versioned GET endpoint", async () => {
    const source = await readFile(
      new URL("../openapi/occ-core.yaml", import.meta.url),
      "utf8",
    );
    const document = parse(source) as OpenApiDocument;
    const operation = document.paths["/api/v1/system/status"]?.get;
    const response = operation?.responses?.["200"];
    const jsonContent = response?.content?.["application/json"];

    expect(operation).toBeDefined();
    expect(response).toBeDefined();
    expect(jsonContent).toBeDefined();
    expect(jsonContent?.schema?.$ref).toBe(
      "#/components/schemas/SystemStatus",
    );
  });

  it("documents authenticated evidence, risk, resource, and reservation groups", async () => {
    const source = await readFile(
      new URL("../openapi/occ-core.yaml", import.meta.url),
      "utf8",
    );
    const document = parse(source) as OpenApiDocument;
    const expectedPaths = [
      "/api/v1/evidence/requirements",
      "/api/v1/evidence/requirements/{requirementId}",
      "/api/v1/evidence/upload-sessions",
      "/api/v1/evidence/upload-sessions/{uploadSessionId}",
      "/api/v1/evidence/upload-sessions/{uploadSessionId}/content",
      "/api/v1/evidence/{evidenceId}",
      "/api/v1/evidence/{evidenceId}/submit",
      "/api/v1/evidence/{evidenceId}/reviews",
      "/api/v1/evidence/{evidenceId}/versions",
      "/api/v1/evidence/{evidenceId}/preview",
      "/api/v1/evidence/{evidenceId}/download",
      "/api/v1/evidence/{evidenceId}/download-metadata",
      "/api/v1/risks",
      "/api/v1/risks/{riskId}",
      "/api/v1/risks/{riskId}/actions",
      "/api/v1/risks/interventions",
      "/api/v1/risks/adjudications",
      "/api/v1/risks/metrics",
      "/api/v1/risks/evaluations/latest",
      "/api/v1/resources",
      "/api/v1/resources/{resourceId}",
      "/api/v1/resources/{resourceId}/availability",
      "/api/v1/resources/{resourceId}/availability-checks",
      "/api/v1/resources/{resourceId}/schedule",
      "/api/v1/reservations",
      "/api/v1/reservations/{reservationId}",
      "/api/v1/reservations/{reservationId}/change",
      "/api/v1/reservations/{reservationId}/cancel",
    ];

    expect(Object.keys(document.paths)).toEqual(expect.arrayContaining(expectedPaths));
    for (const path of expectedPaths) {
      const pathItem = document.paths[path];
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!HTTP_METHODS.has(method)) continue;
        expect(operation.security).toBeUndefined();
        expect(Object.keys(operation.responses ?? {})).toEqual(
          expect.arrayContaining(["401", "403", "500"]),
        );
      }
    }
  });

  it("exposes the latest risk evaluation summary with Zod parity", async () => {
    const source = await readFile(
      new URL("../openapi/occ-core.yaml", import.meta.url),
      "utf8",
    );
    const document = parse(source) as OpenApiDocument;
    const operation = document.paths["/api/v1/risks/evaluations/latest"]?.get;

    expect(operation?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref).toBe(
      "#/components/schemas/RiskEvaluationSummary",
    );
    expectStrictObjectParity(
      document.components.schemas.RiskEvaluationSummary,
      riskEvaluationSummarySchema.shape,
      "RiskEvaluationSummary",
    );
  });

  it("documents bounded evidence range requests and partial responses", async () => {
    const source = await readFile(
      new URL("../openapi/occ-core.yaml", import.meta.url),
      "utf8",
    );
    const document = parse(source) as OpenApiDocument;
    const operation = document.paths["/api/v1/evidence/{evidenceId}/download"]?.get;
    const parameterRefs = operation?.parameters?.map((parameter) => parameter.$ref) ?? [];

    expect(parameterRefs).toContain("#/components/parameters/Range");
    expect(document.components.parameters?.Range?.required).toBe(false);
    expect(operation?.responses?.["200"]?.headers).toEqual(expect.objectContaining({
      "Accept-Ranges": expect.anything(),
    }));
    expect(operation?.responses?.["206"]?.headers).toEqual(expect.objectContaining({
      "Accept-Ranges": expect.anything(),
      "Content-Range": expect.anything(),
    }));
    expect(operation?.responses?.["206"]?.content?.["application/octet-stream"]).toBeDefined();
    const invalidRangeRef = operation?.responses?.["416"]?.$ref?.replace("#/components/responses/", "");
    expect(document.components.responses?.[invalidRangeRef ?? ""]?.headers).toEqual(expect.objectContaining({
      "Accept-Ranges": expect.anything(),
      "Content-Range": expect.anything(),
    }));
  });

  it("wires domain filters to cursor queries", async () => {
    const source = await readFile(
      new URL("../openapi/occ-core.yaml", import.meta.url),
      "utf8",
    );
    const document = parse(source) as OpenApiDocument;
    const parameterRefs = (operation: OpenApiOperation | undefined) =>
      operation?.parameters?.map((parameter) => parameter.$ref) ?? [];

    expect(parameterRefs(document.paths["/api/v1/risks"]?.get)).toEqual(expect.arrayContaining([
      "#/components/parameters/RiskSeverityFilter",
      "#/components/parameters/RiskStateFilter",
      "#/components/parameters/RiskSlaStatusFilter",
      "#/components/parameters/TargetEntityFilter",
    ]));
    expect(parameterRefs(document.paths["/api/v1/risks/interventions"]?.get)).toContain(
      "#/components/parameters/OwnedByMeFilter",
    );
    expect(parameterRefs(document.paths["/api/v1/resources"]?.get)).toEqual(expect.arrayContaining([
      "#/components/parameters/ResourceTypeFilter",
      "#/components/parameters/ResourceStateFilter",
      "#/components/parameters/MinimumCapacityFilter",
    ]));
    expect(parameterRefs(document.paths["/api/v1/resources/{resourceId}/schedule"]?.get)).toEqual(expect.arrayContaining([
      "#/components/parameters/ScheduleFrom",
      "#/components/parameters/ScheduleUntil",
    ]));
  });

  it("requires command concurrency headers and documents correlation and replay", async () => {
    const source = await readFile(
      new URL("../openapi/occ-core.yaml", import.meta.url),
      "utf8",
    );
    const document = parse(source) as OpenApiDocument;
    const createCommands = [
      document.paths["/api/v1/evidence/upload-sessions"]?.post,
      document.paths["/api/v1/risks/adjudications"]?.post,
      document.paths["/api/v1/resources/{resourceId}/availability"]?.post,
      document.paths["/api/v1/reservations"]?.post,
    ];
    const updateCommands = [
      document.paths["/api/v1/evidence/{evidenceId}/submit"]?.post,
      document.paths["/api/v1/evidence/{evidenceId}/reviews"]?.post,
      document.paths["/api/v1/resources/{resourceId}"]?.patch,
      document.paths["/api/v1/resources/{resourceId}/availability"]?.post,
      document.paths["/api/v1/reservations/{reservationId}/change"]?.post,
      document.paths["/api/v1/reservations/{reservationId}/cancel"]?.post,
    ];
    const riskPath = document.paths["/api/v1/risks/{riskId}/actions"];
    const commands = [...createCommands, ...updateCommands, riskPath?.post];

    for (const operation of commands) {
      const refs = operation?.parameters?.map((parameter) => parameter.$ref) ?? [];
      expect(refs).toEqual(expect.arrayContaining([
        "#/components/parameters/IdempotencyKey",
        "#/components/parameters/CorrelationId",
      ]));
      for (const response of Object.values(operation?.responses ?? {})) {
        if (response.$ref) continue;
        expect(response.headers).toEqual(expect.objectContaining({
          "X-Correlation-ID": expect.anything(),
          "Idempotency-Replayed": expect.anything(),
        }));
      }
    }
    for (const operation of updateCommands) {
      expect(operation?.parameters?.map((parameter) => parameter.$ref)).toContain(
        "#/components/parameters/ExpectedVersion",
      );
    }
  });

  it("defines strict domain schemas, opaque cursor pages, and stable OCC errors", async () => {
    const source = await readFile(
      new URL("../openapi/occ-core.yaml", import.meta.url),
      "utf8",
    );
    const document = parse(source) as OpenApiDocument;
    const schemas = document.components.schemas;
    const strictSchemas = [
      "EvidenceRequirement",
      "CreateEvidenceUploadSessionRequest",
      "EvidenceUploadSession",
      "EvidenceContentResult",
      "EvidenceMetadata",
      "ReviewEvidenceRequest",
      "Risk",
      "RiskAction",
      "InterventionItem",
      "ManagedResource",
      "AvailabilityWindow",
      "Reservation",
      "ReservationConflict",
    ];
    for (const name of strictSchemas) {
      expect(schemas[name]?.type).toBe("object");
      expect(schemas[name]?.additionalProperties).toBe(false);
    }
    for (const name of [
      "EvidenceVersionPage",
      "EvidenceReviewPage",
      "RiskPage",
      "RiskActionPage",
      "InterventionPage",
      "ManagedResourcePage",
      "ReservationSchedulePage",
      "RiskAdjudicationPage",
    ]) {
      expect(schemas[name]?.properties?.nextCursor).toEqual({ $ref: "#/components/schemas/OpaqueCursor" });
      expect(schemas[name]?.properties?.previousCursor).toEqual({ $ref: "#/components/schemas/OpaqueCursor" });
    }
    expect(schemas.OccProblemCode?.enum).toEqual(OCC_PROBLEM_CODES);
    expect(schemas.ProblemDetails?.properties?.code).toEqual({
      $ref: "#/components/schemas/OccProblemCode",
    });
    expect(schemas.RiskActionCommandRequest?.oneOf).toHaveLength(6);
    for (const variant of schemas.RiskActionCommandRequest?.oneOf ?? []) {
      expect(variant.type).toBe("object");
      expect(variant.additionalProperties).toBe(false);
    }
  });

  it("accepts every Core runtime problem code and rejects unknown codes", async () => {
    const [openApiSource, runtimeSource] = await Promise.all([
      readFile(new URL("../openapi/occ-core.yaml", import.meta.url), "utf8"),
      readFile(
        new URL(
          "../../../services/core/src/main/kotlin/com/innorder/occ/api/OccProblem.kt",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);
    const schemas = (parse(openApiSource) as OpenApiDocument).components.schemas;
    const validateProblem = createOpenApiSchemaValidator(schemas, "ProblemDetails");
    const runtimeCodes = [...new Set(
      [...runtimeSource.matchAll(/"(OCC-[A-Z0-9-]+)"/g)].map((match) => match[1]),
    )].sort();
    const base = {
      type: "https://innorder.local/problems/validation",
      title: "Runtime problem",
      status: 400,
      correlationId: "11111111-1111-4111-8111-111111111111",
    };

    expect(runtimeCodes.length).toBeGreaterThan(0);
    for (const code of runtimeCodes) {
      const problem = { ...base, code };
      expect(problemDetailsSchema.safeParse(problem).success, code).toBe(true);
      expect(domainProblemDetailsSchema.safeParse(problem).success, code).toBe(true);
      expect(validateProblem(problem), `${code}: ${JSON.stringify(validateProblem.errors)}`).toBe(true);
    }
    const unknown = { ...base, code: "OCC-UNKNOWN-CODE" };
    expect(problemDetailsSchema.safeParse(unknown).success).toBe(false);
    expect(domainProblemDetailsSchema.safeParse(unknown).success).toBe(false);
    expect(validateProblem(unknown)).toBe(false);
  });

  it("defines a discriminated strict domain event envelope union", async () => {
    const source = await readFile(
      new URL("../openapi/occ-core.yaml", import.meta.url),
      "utf8",
    );
    const schemas = (parse(source) as OpenApiDocument).components.schemas;
    const domainEnvelope = schemas.DomainEventEnvelope;

    expect(domainEnvelope?.oneOf).toHaveLength(14);
    expect(domainEnvelope?.discriminator?.propertyName).toBe("type");
    expect(Object.keys(domainEnvelope?.discriminator?.mapping ?? {})).toHaveLength(14);

    const validateEnvelope = createOpenApiSchemaValidator(schemas, "DomainEventEnvelope");
    const envelope = {
      id: "11111111-1111-4111-8111-111111111111",
      customerInstanceId: "22222222-2222-4222-8222-222222222222",
      type: "EVIDENCE_SUBMITTED",
      schemaVersion: 1,
      aggregateType: "EVIDENCE",
      aggregateId: "11111111-1111-4111-8111-111111111111",
      aggregateVersion: 2,
      occurredAt: "2026-08-01T10:30:00+02:00",
      correlationId: "22222222-2222-4222-8222-222222222222",
      payload: {
        evidenceId: "11111111-1111-4111-8111-111111111111",
        state: "SUBMITTED",
        version: 2,
        evidenceVersion: 1,
      },
    };
    expect(validateEnvelope(envelope), JSON.stringify(validateEnvelope.errors)).toBe(true);
    for (const forbidden of ["credentials", "token", "unknown"]) {
      expect(validateEnvelope({ ...envelope, [forbidden]: "secret" })).toBe(false);
    }
    expect(validateEnvelope({ ...envelope, type: "RISK_OPENED" })).toBe(false);
  });

  it("enforces review and adjudication cross-field rules in Zod and OpenAPI", async () => {
    const source = await readFile(
      new URL("../openapi/occ-core.yaml", import.meta.url),
      "utf8",
    );
    const schemas = (parse(source) as OpenApiDocument).components.schemas;
    const validateReview = createOpenApiSchemaValidator(schemas, "ReviewEvidenceRequest");
    const validateAdjudication = createOpenApiSchemaValidator(schemas, "CreateRiskAdjudicationRequest");
    const reviewFixtures = [
      {
        valid: true,
        value: { evidenceVersion: 1, decision: "CONDITIONAL", reason: "Follow up.", conditions: [{ code: "FOLLOW_UP", detail: "Add signature." }] },
      },
      {
        valid: true,
        value: { evidenceVersion: 1, decision: "ACCEPTED", reason: "Complete." },
      },
      {
        valid: false,
        value: { evidenceVersion: 1, decision: "CONDITIONAL", reason: "Missing conditions." },
      },
      {
        valid: false,
        value: { evidenceVersion: 1, decision: "REJECTED", reason: "Invalid conditions.", conditions: [{ code: "NO", detail: "Not allowed." }] },
      },
    ];
    const adjudicationBase = {
      reportingPeriodStart: "2026-07-01",
      reportingPeriodEnd: "2026-08-01",
      knownEventKey: "severe:42",
      targetEntityId: "11111111-1111-4111-8111-111111111111",
      severeEvent: true,
      outcome: "MISSED",
      reason: "No risk opened.",
    };
    const adjudicationFixtures = [
      { valid: true, value: adjudicationBase },
      { valid: false, value: { ...adjudicationBase, riskId: "22222222-2222-4222-8222-222222222222" } },
      { valid: true, value: { ...adjudicationBase, outcome: "TRUE_POSITIVE", riskId: "22222222-2222-4222-8222-222222222222" } },
    ];

    for (const fixture of reviewFixtures) {
      expect(reviewEvidenceRequestSchema.safeParse(fixture.value).success).toBe(fixture.valid);
      expect(validateReview(fixture.value), JSON.stringify(validateReview.errors)).toBe(fixture.valid);
    }
    for (const fixture of adjudicationFixtures) {
      expect(createRiskAdjudicationRequestSchema.safeParse(fixture.value).success).toBe(fixture.valid);
      expect(validateAdjudication(fixture.value), JSON.stringify(validateAdjudication.errors)).toBe(fixture.valid);
    }
  });

  it("keeps strict domain Zod and OpenAPI object shapes in parity", async () => {
    const source = await readFile(
      new URL("../openapi/occ-core.yaml", import.meta.url),
      "utf8",
    );
    const schemas = (parse(source) as OpenApiDocument).components.schemas;
    const contracts = {
      HalfOpenInterval: halfOpenIntervalSchema,
      EvidenceRequirement: evidenceRequirementSchema,
      EvidenceRequirementPage: evidenceRequirementPageSchema,
      CreateEvidenceUploadSessionRequest: createEvidenceUploadSessionRequestSchema,
      EvidenceUploadSession: evidenceUploadSessionSchema,
      EvidenceContentResult: evidenceContentResultSchema,
      EvidenceMetadata: evidenceMetadataSchema,
      SubmitEvidenceRequest: submitEvidenceRequestSchema,
      EvidenceReviewCondition: evidenceReviewConditionSchema,
      ReviewEvidenceRequest: reviewEvidenceRequestSchema,
      EvidenceVersion: evidenceVersionSchema,
      EvidenceReview: evidenceReviewSchema,
      EvidenceVersionPage: evidenceVersionPageSchema,
      EvidenceReviewPage: evidenceReviewPageSchema,
      EvidencePreviewMetadata: evidencePreviewMetadataSchema,
      EvidenceDownloadMetadata: evidenceDownloadMetadataSchema,
      Risk: riskSchema,
      RiskPage: riskPageSchema,
      RiskAction: riskActionSchema,
      RiskActionPage: riskActionPageSchema,
      InterventionItem: interventionItemSchema,
      InterventionPage: interventionPageSchema,
      CreateRiskAdjudicationRequest: createRiskAdjudicationRequestSchema,
      RiskAdjudication: riskAdjudicationSchema,
      RiskAdjudicationPage: riskAdjudicationPageSchema,
      RiskMetrics: riskMetricsSchema,
      ManagedResource: managedResourceSchema,
      ManagedResourcePage: managedResourcePageSchema,
      UpdateResourceRequest: updateResourceRequestSchema,
      AvailabilityWindow: availabilityWindowSchema,
      CreateAvailabilityWindowRequest: createAvailabilityWindowRequestSchema,
      AvailabilityWindowPage: availabilityWindowPageSchema,
      ReservationConflict: reservationConflictSchema,
      ReservationAvailabilityRequest: reservationAvailabilityRequestSchema,
      ReservationAvailability: reservationAvailabilitySchema,
      Reservation: reservationSchema,
      ReservationSchedulePage: reservationSchedulePageSchema,
      ReserveResourceRequest: reserveResourceRequestSchema,
      ChangeReservationRequest: changeReservationRequestSchema,
      CancelReservationRequest: cancelReservationRequestSchema,
      EvidenceEventPayload: evidenceEventPayloadSchema,
      RiskEventPayload: riskEventPayloadSchema,
      ResourceEventPayload: resourceEventPayloadSchema,
      ReservationEventPayload: reservationEventPayloadSchema,
    };

    for (const [name, schema] of Object.entries(contracts)) {
      expectStrictObjectParity(schemas[name], schema.shape, name);
    }
  });

  it("keeps status public while protecting authenticated operations", async () => {
    const source = await readFile(
      new URL("../openapi/occ-core.yaml", import.meta.url),
      "utf8",
    );
    const document = parse(source) as OpenApiDocument;

    expect(document.security).toEqual([{ bearerAuth: [] }]);
    expect(document.paths["/api/v1/system/status"]?.get?.security).toEqual([]);
    expect(document.paths["/api/v1/auth/login"]?.post?.security).toEqual([]);
    expect(document.paths["/api/v1/auth/refresh"]?.post?.security).toEqual([]);
    expect(document.paths["/api/v1/auth/logout"]?.post?.security).toBeUndefined();
    expect(document.paths["/api/v1/me"]?.get?.security).toBeUndefined();
  });

  it("wires auth request, success, and problem response contracts", async () => {
    const source = await readFile(
      new URL("../openapi/occ-core.yaml", import.meta.url),
      "utf8",
    );
    const document = parse(source) as OpenApiDocument;
    const login = document.paths["/api/v1/auth/login"]?.post;
    const refresh = document.paths["/api/v1/auth/refresh"]?.post;
    const logout = document.paths["/api/v1/auth/logout"]?.post;
    const me = document.paths["/api/v1/me"]?.get;

    expect(login?.requestBody?.content?.["application/json"]?.schema?.$ref).toBe(
      "#/components/schemas/LoginRequest",
    );
    expect(refresh?.requestBody?.content?.["application/json"]?.schema?.$ref).toBe(
      "#/components/schemas/RefreshRequest",
    );
    expect(logout?.requestBody?.content?.["application/json"]?.schema?.$ref).toBe(
      "#/components/schemas/RefreshRequest",
    );
    expect(login?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref).toBe(
      "#/components/schemas/TokenResponse",
    );
    expect(refresh?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref).toBe(
      "#/components/schemas/TokenResponse",
    );
    expect(me?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref).toBe(
      "#/components/schemas/CurrentUser",
    );
    expect(logout?.responses?.["204"]).toBeDefined();
    expect(document.components.schemas.LoginRequest?.properties?.password).toEqual({
      type: "string",
      minLength: LOGIN_PASSWORD_MIN_CODE_POINTS,
      maxLength: LOGIN_PASSWORD_MAX_CODE_POINTS,
    });

    for (const response of Object.values(document.components.responses ?? {})) {
      expect(response.content?.["application/problem+json"]?.schema?.$ref).toBe(
        "#/components/schemas/ProblemDetails",
      );
    }
  });

  it("uses ProblemDetails for every documented operation error", async () => {
    const source = await readFile(
      new URL("../openapi/occ-core.yaml", import.meta.url),
      "utf8",
    );
    const document = parse(source) as OpenApiDocument;

    expect(
      Object.keys(document.paths["/api/v1/auth/login"]?.post?.responses ?? {}),
    ).toEqual(expect.arrayContaining(["400", "401", "429", "500"]));
    expect(
      Object.keys(document.paths["/api/v1/auth/refresh"]?.post?.responses ?? {}),
    ).toEqual(expect.arrayContaining(["400", "401", "500"]));
    expect(
      Object.keys(document.paths["/api/v1/auth/logout"]?.post?.responses ?? {}),
    ).toEqual(expect.arrayContaining(["400", "401", "500"]));

    for (const pathItem of Object.values(document.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!HTTP_METHODS.has(method)) continue;

        const errorResponses = Object.entries(operation.responses ?? {}).filter(
          ([status]) => /^[45]\d\d$/.test(status),
        );
        expect(errorResponses.length).toBeGreaterThan(0);

        for (const [, response] of errorResponses) {
          const componentName = response.$ref?.replace(
            "#/components/responses/",
            "",
          );
          const resolvedResponse = componentName
            ? document.components.responses?.[componentName]
            : response;
          expect(
            resolvedResponse?.content?.["application/problem+json"]?.schema?.$ref,
          ).toBe("#/components/schemas/ProblemDetails");
        }
      }
    }
  });

  it("matches all strict platform Zod contracts", async () => {
    const source = await readFile(
      new URL("../openapi/occ-core.yaml", import.meta.url),
      "utf8",
    );
    const schemas = (parse(source) as OpenApiDocument).components.schemas;

    expectStrictObjectParity(schemas.ProblemDetails, problemDetailsSchema.shape);
    expect(schemas.ProblemDetails?.properties).toEqual({
      type: { type: "string", format: "uri" },
      title: {
        type: "string",
        minLength: PROBLEM_TITLE_MIN_LENGTH,
        maxLength: PROBLEM_TITLE_MAX_LENGTH,
      },
      status: {
        type: "integer",
        minimum: PROBLEM_STATUS_MIN,
        maximum: PROBLEM_STATUS_MAX,
      },
      code: { $ref: "#/components/schemas/OccProblemCode" },
      correlationId: { type: "string", format: "uuid" },
      detail: {
        type: "string",
        minLength: PROBLEM_DETAIL_MIN_LENGTH,
        maxLength: PROBLEM_DETAIL_MAX_LENGTH,
      },
      currentVersion: {
        type: "integer",
        format: "int64",
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      },
    });

    expectStrictObjectParity(schemas.LoginRequest, loginRequestSchema.shape);
    expect(schemas.LoginRequest?.properties).toEqual({
      username: {
        type: "string",
        minLength: LOGIN_USERNAME_MIN_LENGTH,
        maxLength: LOGIN_USERNAME_MAX_LENGTH,
        pattern: LOGIN_USERNAME_PATTERN,
      },
      password: {
        type: "string",
        minLength: LOGIN_PASSWORD_MIN_CODE_POINTS,
        maxLength: LOGIN_PASSWORD_MAX_CODE_POINTS,
      },
    });

    expectStrictObjectParity(schemas.RefreshRequest, refreshRequestSchema.shape);
    expect(schemas.RefreshRequest?.properties).toEqual({
      refreshToken: {
        type: "string",
        minLength: REFRESH_TOKEN_LENGTH,
        maxLength: REFRESH_TOKEN_LENGTH,
        pattern: REFRESH_TOKEN_PATTERN,
      },
    });

    expectStrictObjectParity(schemas.CurrentUser, currentUserSchema.shape);
    expect(schemas.CurrentUser?.properties).toEqual({
      id: { type: "string", format: "uuid" },
      username: {
        type: "string",
        minLength: CURRENT_USER_USERNAME_MIN_LENGTH,
        maxLength: CURRENT_USER_USERNAME_MAX_LENGTH,
      },
      displayName: {
        type: "string",
        minLength: CURRENT_USER_DISPLAY_NAME_MIN_LENGTH,
        maxLength: CURRENT_USER_DISPLAY_NAME_MAX_LENGTH,
      },
      status: {
        type: "string",
        enum: ["ACTIVE", "LOCKED", "DISABLED", "ARCHIVED"],
      },
      capabilities: {
        type: "array",
        items: {
          type: "string",
          minLength: CAPABILITY_MIN_LENGTH,
          maxLength: CAPABILITY_MAX_LENGTH,
        },
      },
    });

    expectStrictObjectParity(schemas.TokenResponse, tokenResponseSchema.shape);
    expect(schemas.TokenResponse?.properties).toEqual({
      tokenType: { type: "string", const: "Bearer" },
      accessToken: {
        type: "string",
        minLength: ACCESS_TOKEN_MIN_LENGTH,
        maxLength: ACCESS_TOKEN_MAX_LENGTH,
      },
      refreshToken: {
        type: "string",
        minLength: REFRESH_TOKEN_LENGTH,
        maxLength: REFRESH_TOKEN_LENGTH,
        pattern: REFRESH_TOKEN_PATTERN,
      },
      expiresIn: {
        type: "integer",
        minimum: EXPIRES_IN_MIN_SECONDS,
        maximum: EXPIRES_IN_MAX_SECONDS,
      },
      user: { $ref: "#/components/schemas/CurrentUser" },
    });

    expectStrictObjectParity(schemas.EventEnvelope, eventEnvelopeSchema.shape);
    expect(schemas.EventEnvelope?.properties).toEqual({
      id: { type: "string", format: "uuid" },
      customerInstanceId: { type: "string", format: "uuid" },
      type: {
        type: "string",
        minLength: EVENT_TYPE_MIN_LENGTH,
        maxLength: EVENT_TYPE_MAX_LENGTH,
      },
      schemaVersion: {
        type: "integer",
        minimum: EVENT_SCHEMA_VERSION_MIN,
        maximum: EVENT_SCHEMA_VERSION_MAX,
      },
      aggregateType: {
        type: "string",
        minLength: EVENT_AGGREGATE_TYPE_MIN_LENGTH,
        maxLength: EVENT_AGGREGATE_TYPE_MAX_LENGTH,
      },
      aggregateId: { type: "string", format: "uuid" },
      aggregateVersion: {
        type: "integer",
        minimum: EVENT_AGGREGATE_VERSION_MIN,
        maximum: EVENT_AGGREGATE_VERSION_MAX,
      },
      occurredAt: {
        type: "string",
        format: "date-time",
        pattern: EVENT_OCCURRED_AT_PATTERN,
      },
      actorId: { type: "string", format: "uuid" },
      correlationId: { type: "string", format: "uuid" },
      causationId: { type: "string", format: "uuid" },
      payload: { type: "object", additionalProperties: true },
    });
  });

  it("matches the strict Zod system-status contract", async () => {
    const source = await readFile(
      new URL("../openapi/occ-core.yaml", import.meta.url),
      "utf8",
    );
    const document = parse(source) as OpenApiDocument;
    const schemas = document.components.schemas;
    const serviceState = schemas.ServiceState;
    const componentStatus = schemas.ComponentStatus;
    const systemStatus = schemas.SystemStatus;

    expect(serviceState?.enum).toEqual(ServiceStateSchema.options);

    expect(componentStatus?.additionalProperties).toBe(false);
    expect(componentStatus?.required).toEqual(
      requiredKeys(ComponentStatusSchema.shape),
    );
    expect(Object.keys(componentStatus?.properties ?? {})).toEqual(
      Object.keys(ComponentStatusSchema.shape),
    );
    expect(componentStatus?.properties).toEqual({
      id: { type: "string" },
      label: { type: "string" },
      state: { $ref: "#/components/schemas/ServiceState" },
      detail: { type: "string" },
      checkedAt: { type: "string", format: "date-time" },
    });

    expect(systemStatus?.additionalProperties).toBe(false);
    expect(systemStatus?.required).toEqual(
      requiredKeys(SystemStatusSchema.shape),
    );
    expect(Object.keys(systemStatus?.properties ?? {})).toEqual(
      Object.keys(SystemStatusSchema.shape),
    );
    expect(systemStatus?.properties).toEqual({
      service: { type: "string" },
      version: { type: "string" },
      state: { $ref: "#/components/schemas/ServiceState" },
      checkedAt: { type: "string", format: "date-time" },
      components: {
        type: "array",
        items: { $ref: "#/components/schemas/ComponentStatus" },
      },
    });
  });
});
