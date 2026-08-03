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
  EVENT_STABLE_TYPE_PATTERN,
  EVENT_TYPE_MAX_LENGTH,
  EVENT_TYPE_MIN_LENGTH,
} from "../src/events.js";
import {
  availabilityWindowPageSchema,
  availabilityWindowSchema,
  cancelReservationRequestSchema,
  changeReservationRequestSchema,
  confirmedEvidenceContentResultSchema,
  createAvailabilityWindowRequestSchema,
  createEvidenceUploadSessionRequestSchema,
  createRiskAdjudicationRequestSchema,
  domainProblemDetailsSchema,
  evidenceDownloadMetadataSchema,
  evidenceEventPayloadSchema,
  evidenceMetadataSchema,
  evidencePreviewMetadataSchema,
  evidenceRangeHeaderSchema,
  evidenceRequirementPageSchema,
  evidenceRequirementSchema,
  evidenceReviewConditionSchema,
  evidenceReviewPageSchema,
  evidenceReviewSchema,
  evidenceUploadSessionSchema,
  evidenceVersionPageSchema,
  evidenceVersionSchema,
  failedEvidenceContentResultSchema,
  halfOpenIntervalSchema,
  interventionItemSchema,
  interventionPageSchema,
  managedResourcePageSchema,
  managedResourceSchema,
  reservationAvailabilityRequestSchema,
  reservationAvailabilitySchema,
  reservationConflictSchema,
  redactedReservationConflictDescriptorSchema,
  reservationEventPayloadSchema,
  reservationSchedulePageSchema,
  reservationScheduleFiltersSchema,
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
  unredactedReservationConflictDescriptorSchema,
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
  "x-occ-problem-details"?: boolean;
}

interface OpenApiSchemaProperty {
  $ref?: string;
  additionalProperties?: boolean;
  allOf?: OpenApiSchemaProperty[];
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
  "x-occ-semantic-validation"?: {
    rules: string[];
    validator: string;
  };
}

interface OpenApiParameter {
  $ref?: string;
  in?: string;
  name?: string;
  required?: boolean;
  schema?: OpenApiSchemaProperty;
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
  patch?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
}

interface OpenApiOperation {
  parameters?: OpenApiParameter[];
  requestBody?: {
    content?: Record<string, { schema?: { $ref?: string } }>;
  };
  security?: Array<Record<string, string[]>>;
  responses?: Record<string, OpenApiResponse>;
  "x-occ-semantic-validation"?: {
    rules: string[];
    validator: string;
  };
}

interface OpenApiResponse {
  content?: Record<string, { schema?: { $ref?: string } }>;
  headers?: Record<string, unknown>;
  content?: Record<string, { schema?: OpenApiSchemaProperty }>;
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

const expectSharedFixtureValidation = (
  structuralValidator: ReturnType<typeof createOpenApiSchemaValidator>,
  runtimeSchema: { safeParse: (value: unknown) => { success: boolean } },
  fixtures: Array<{ structural: boolean; valid: boolean; value: unknown }>,
): void => {
  for (const fixture of fixtures) {
    const structurallyValid = structuralValidator(fixture.value);
    expect(structurallyValid, JSON.stringify(structuralValidator.errors)).toBe(
      fixture.structural,
    );
    expect(structurallyValid && runtimeSchema.safeParse(fixture.value).success).toBe(
      fixture.valid,
    );
  }
};

const createInlineOpenApiSchemaValidator = (
  schemas: Record<string, OpenApiSchema>,
  schema: OpenApiSchemaProperty,
) => {
  const rewritten = JSON.parse(
    JSON.stringify({ schema, schemas }).replaceAll(
      "#/components/schemas/",
      "#/$defs/",
    ),
  ) as { schema: object; schemas: Record<string, unknown> };
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile({ ...rewritten.schema, $defs: rewritten.schemas });
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

const derivesFromProblemDetails = (
  schema: OpenApiSchemaProperty | undefined,
  schemas: Record<string, OpenApiSchema>,
  seen = new Set<string>(),
): boolean => {
  if (schema?.$ref === "#/components/schemas/ProblemDetails") return true;
  if ((schema as OpenApiSchema | undefined)?.["x-occ-problem-details"] === true) return true;
  if (schema?.$ref) {
    const name = schema.$ref.replace("#/components/schemas/", "");
    if (seen.has(name)) return false;
    return derivesFromProblemDetails(schemas[name], schemas, new Set(seen).add(name));
  }
  if (schema?.allOf?.some((member) => derivesFromProblemDetails(member, schemas, seen))) {
    return true;
  }
  return schema?.oneOf?.every((member) => derivesFromProblemDetails(member, schemas, seen)) ?? false;
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

  it("aligns structural and semantic validation for byte ranges", async () => {
    const source = await readFile(
      new URL("../openapi/occ-core.yaml", import.meta.url),
      "utf8",
    );
    const document = parse(source) as OpenApiDocument;
    const rangeSchema = document.components.parameters?.Range?.schema;

    expect(rangeSchema?.["x-occ-semantic-validation"]).toEqual({
      validator: "evidenceRangeHeaderSchema",
      rules: [
        "suffix-length-positive",
        "offsets-js-safe-integers",
        "end-not-before-start",
      ],
    });
    const validateRange = createInlineOpenApiSchemaValidator(
      document.components.schemas,
      rangeSchema ?? {},
    );
    expectSharedFixtureValidation(validateRange, evidenceRangeHeaderSchema, [
      { value: "bytes=0-499", structural: true, valid: true },
      { value: "bytes=500-", structural: true, valid: true },
      { value: "bytes=-500", structural: true, valid: true },
      { value: "bytes=-0", structural: false, valid: false },
      { value: "bytes=500-499", structural: true, valid: false },
      { value: `bytes=0-${Number.MAX_SAFE_INTEGER + 1}`, structural: true, valid: false },
    ]);
  });

  it("documents and validates positive intervals across resources and events", async () => {
    const source = await readFile(
      new URL("../openapi/occ-core.yaml", import.meta.url),
      "utf8",
    );
    const schemas = (parse(source) as OpenApiDocument).components.schemas;
    const start = "2026-08-01T10:30:00+02:00";
    const end = "2026-08-01T11:30:00+02:00";
    const interval = { start, end };
    const reversed = { start: end, end: start };
    const id = "11111111-1111-4111-8111-111111111111";
    const contracts = [
      ["HalfOpenInterval", halfOpenIntervalSchema, interval],
      ["AvailabilityWindow", availabilityWindowSchema, { id, resourceId: id, interval, mode: "AVAILABLE", createdAt: start }],
      ["CreateAvailabilityWindowRequest", createAvailabilityWindowRequestSchema, { interval, mode: "UNAVAILABLE" }],
      ["ReservationConflict", reservationConflictSchema, { resourceId: id, interval, kind: "CAPACITY", redacted: true }],
      ["ReservationAvailabilityRequest", reservationAvailabilityRequestSchema, { interval, capacity: 1, exclusive: false }],
      ["ReservationAvailability", reservationAvailabilitySchema, { resourceId: id, interval, requestedCapacity: 1, available: true, remainingCapacity: 1, conflicts: [] }],
      ["Reservation", reservationSchema, { id, resourceId: id, interval, capacity: 1, exclusive: false, state: "CONFIRMED", version: 1, createdAt: start, updatedAt: start }],
      ["ReserveResourceRequest", reserveResourceRequestSchema, { resourceId: id, requesterEntityId: id, interval, capacity: 1, exclusive: false }],
      ["ChangeReservationRequest", changeReservationRequestSchema, { interval, capacity: 1, exclusive: false }],
      ["ResourceEventPayload", resourceEventPayloadSchema, { resourceId: id, state: "AVAILABLE", version: 1, interval }],
      ["ReservationEventPayload", reservationEventPayloadSchema, { reservationId: id, resourceId: id, state: "CONFIRMED", version: 1, interval, capacity: 1, exclusive: false }],
    ] as const;

    expect(schemas.HalfOpenInterval?.["x-occ-semantic-validation"]).toEqual({
      validator: "halfOpenIntervalSchema",
      rules: ["start-before-end"],
    });
    for (const [name, runtimeSchema, valid] of contracts) {
      const invalid = name === "HalfOpenInterval"
        ? reversed
        : { ...valid, interval: reversed };
      expectSharedFixtureValidation(
        createOpenApiSchemaValidator(schemas, name),
        runtimeSchema,
        [
          { value: valid, structural: true, valid: true },
          { value: invalid, structural: true, valid: false },
        ],
      );
    }
  });

  it("documents and validates reporting and schedule period ordering", async () => {
    const source = await readFile(
      new URL("../openapi/occ-core.yaml", import.meta.url),
      "utf8",
    );
    const document = parse(source) as OpenApiDocument;
    const schemas = document.components.schemas;
    const id = "11111111-1111-4111-8111-111111111111";
    const createdAt = "2026-08-01T10:30:00+02:00";
    const contracts = [
      ["CreateRiskAdjudicationRequest", createRiskAdjudicationRequestSchema, { reportingPeriodStart: "2026-07-01", reportingPeriodEnd: "2026-08-01", knownEventKey: "event:1", targetEntityId: id, severeEvent: true, outcome: "MISSED", reason: "No risk." }],
      ["RiskAdjudication", riskAdjudicationSchema, { id, reportingPeriodStart: "2026-07-01", reportingPeriodEnd: "2026-08-01", knownEventKey: "event:1", targetEntityId: id, severeEvent: true, outcome: "MISSED", reason: "No risk.", adjudicationVersion: 1, createdAt }],
      ["RiskMetrics", riskMetricsSchema, { reportingPeriodStart: "2026-07-01", reportingPeriodEnd: "2026-08-01", evaluatedCount: 1, severeEventCount: 1, truePositiveCount: 0, falsePositiveCount: 0, missedCount: 1, acknowledgedWithinSlaCount: 0, resolvedCount: 0, generatedAt: createdAt }],
      ["ReservationScheduleFilters", reservationScheduleFiltersSchema, { from: createdAt, until: "2026-08-01T11:30:00+02:00" }],
    ] as const;

    expect(
      document.paths["/api/v1/resources/{resourceId}/schedule"]?.get?.[
        "x-occ-semantic-validation"
      ],
    ).toEqual({
      validator: "reservationScheduleFiltersSchema",
      rules: ["from-before-until"],
    });

    for (const [name, runtimeSchema, valid] of contracts) {
      expect(schemas[name]?.["x-occ-semantic-validation"]).toBeDefined();
      const reversed = name === "ReservationScheduleFilters"
        ? { ...valid, from: valid.until, until: valid.from }
        : { ...valid, reportingPeriodStart: valid.reportingPeriodEnd, reportingPeriodEnd: valid.reportingPeriodStart };
      expectSharedFixtureValidation(
        createOpenApiSchemaValidator(schemas, name),
        runtimeSchema,
        [
          { value: valid, structural: true, valid: true },
          { value: reversed, structural: true, valid: false },
        ],
      );
    }
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
      "ConfirmedEvidenceContentResult",
      "FailedEvidenceContentResult",
      "EvidenceMetadata",
      "ReviewEvidenceRequest",
      "Risk",
      "RiskAction",
      "InterventionItem",
      "ManagedResource",
      "AvailabilityWindow",
      "Reservation",
      "RedactedReservationConflictDescriptor",
      "UnredactedReservationConflictDescriptor",
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
    // The shared document's base problem accepts the platform codes plus the
    // workflow codes, which is exactly what baseProblemCodeSchema validates.
    expect(schemas.ProblemDetails?.properties?.code).toEqual({
      $ref: "#/components/schemas/BaseProblemCode",
    });
    expect(schemas.BaseProblemCode?.enum).toEqual(expect.arrayContaining(OCC_PROBLEM_CODES));
    expect(schemas.RiskActionCommandRequest?.oneOf).toHaveLength(6);
    for (const variant of schemas.RiskActionCommandRequest?.oneOf ?? []) {
      const name = variant.$ref?.replace("#/components/schemas/", "") ?? "";
      expect(schemas[name]?.type).toBe("object");
      expect(schemas[name]?.additionalProperties).toBe(false);
    }
  });

  it("names and discriminates terminal evidence content results", async () => {
    const source = await readFile(
      new URL("../openapi/occ-core.yaml", import.meta.url),
      "utf8",
    );
    const schemas = (parse(source) as OpenApiDocument).components.schemas;
    const result = schemas.EvidenceContentResult;

    expect(result?.oneOf).toEqual([
      { $ref: "#/components/schemas/ConfirmedEvidenceContentResult" },
      { $ref: "#/components/schemas/FailedEvidenceContentResult" },
    ]);
    expect(result?.discriminator).toEqual({
      propertyName: "status",
      mapping: {
        CONFIRMED: "#/components/schemas/ConfirmedEvidenceContentResult",
        FAILED: "#/components/schemas/FailedEvidenceContentResult",
      },
    });
    for (const name of ["ConfirmedEvidenceContentResult", "FailedEvidenceContentResult"]) {
      expect(schemas[name]?.additionalProperties).toBe(false);
    }
  });

  it("uses named risk action command schemas with complete discriminator mapping", async () => {
    const source = await readFile(
      new URL("../openapi/occ-core.yaml", import.meta.url),
      "utf8",
    );
    const schemas = (parse(source) as OpenApiDocument).components.schemas;
    const command = schemas.RiskActionCommandRequest;
    const mapping = {
      ACKNOWLEDGE: "#/components/schemas/AcknowledgeRiskActionCommand",
      ASSIGN: "#/components/schemas/AssignRiskActionCommand",
      ESCALATE: "#/components/schemas/EscalateRiskActionCommand",
      MITIGATE: "#/components/schemas/MitigateRiskActionCommand",
      RESOLVE: "#/components/schemas/ResolveRiskActionCommand",
      DISMISS: "#/components/schemas/DismissRiskActionCommand",
    };

    expect(command?.oneOf).toEqual(
      Object.values(mapping).map(($ref) => ({ $ref })),
    );
    expect(command?.discriminator).toEqual({ propertyName: "action", mapping });
    for (const name of Object.values(mapping).map((ref) => ref.split("/").at(-1) ?? "")) {
      expect(schemas[name]?.additionalProperties).toBe(false);
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
      ConfirmedEvidenceContentResult: confirmedEvidenceContentResultSchema,
      FailedEvidenceContentResult: failedEvidenceContentResultSchema,
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
    expectStrictObjectParity(
      schemas.RedactedReservationConflictDescriptor,
      redactedReservationConflictDescriptorSchema.shape,
      "RedactedReservationConflictDescriptor",
    );
    expectStrictObjectParity(
      schemas.UnredactedReservationConflictDescriptor,
      unredactedReservationConflictDescriptorSchema.shape,
      "UnredactedReservationConflictDescriptor",
    );
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
      expect(derivesFromProblemDetails(
        response.content?.["application/problem+json"]?.schema,
        document.components.schemas,
      )).toBe(true);
    }

    const workflowSchemaByResponse: Record<string, string> = {
      WorkflowRequestError: "WorkflowRequestProblem",
      WorkflowBadRequest: "WorkflowBadRequestProblem",
      WorkflowUnauthorized: "WorkflowUnauthorizedProblem",
      WorkflowForbidden: "WorkflowForbiddenProblem",
      WorkflowNotFound: "WorkflowNotFoundProblem",
      WorkflowInternalError: "WorkflowInternalProblem",
      WorkflowAuthorizationUnavailable: "WorkflowAuthorizationUnavailableProblem",
      WorkflowUnavailable: "WorkflowUnavailableProblem",
      CohortCreationConflict: "CohortCreationConflictProblem",
      VersionedCommandConflict: "VersionedCommandConflictProblem",
      ParticipantProcessStartConflict: "ParticipantProcessStartConflictProblem",
      ProcessCommandConflict: "ProcessCommandConflictProblem",
      ProcessTransferConflict: "ProcessTransferConflictProblem",
      ProcessWaitReleaseConflict: "ProcessWaitReleaseConflictProblem",
      TaskClaimConflict: "TaskClaimConflictProblem",
      TaskCommandConflict: "TaskCommandConflictProblem",
    };
    for (const [name, response] of Object.entries(document.components.responses ?? {})) {
      const schema = response.content?.["application/problem+json"]?.schema;
      if (name === "TaskBlocked") {
        expect(schema?.$ref).toBe("#/components/schemas/TaskCompletionConflictProblem");
      } else if (name === "TaskGateUnavailable") {
        expect(schema?.oneOf).toHaveLength(2);
        expect(schema?.oneOf?.[1]?.$ref).toBe("#/components/schemas/TaskCompletionDependencyProblem");
      } else if (workflowSchemaByResponse[name] !== undefined) {
        expect(schema?.$ref).toBe(`#/components/schemas/${workflowSchemaByResponse[name]}`);
      } else {
        // Domain surfaces publish specialized variants; each must still be an
        // RFC 9457 problem document derived from ProblemDetails.
        expect(
          derivesFromProblemDetails(schema, document.components.schemas),
          `${name}: ${JSON.stringify(schema)}`,
        ).toBe(true);
      }
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

    for (const [path, pathItem] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!HTTP_METHODS.has(method)) continue;

        const errorResponses = Object.entries(operation.responses ?? {}).filter(
          ([status]) => /^[45]\d\d$/.test(status),
        );
        expect(errorResponses.length).toBeGreaterThan(0);

        for (const [status, response] of errorResponses) {
          const componentName = response.$ref?.replace(
            "#/components/responses/",
            "",
          );
          const resolvedResponse = componentName
            ? document.components.responses?.[componentName]
            : response;
          expect(derivesFromProblemDetails(
            resolvedResponse?.content?.["application/problem+json"]?.schema,
            document.components.schemas,
          )).toBe(true);
          const schema = resolvedResponse?.content?.["application/problem+json"]?.schema;
          if (path === "/api/v1/tasks/{taskId}/complete" && status === "409") {
            expect(schema?.$ref).toBe("#/components/schemas/TaskCompletionConflictProblem");
          } else if (path === "/api/v1/tasks/{taskId}/complete" && status === "503") {
            expect(schema?.oneOf).toHaveLength(2);
            expect(schema?.oneOf?.[1]?.$ref).toBe("#/components/schemas/TaskCompletionDependencyProblem");
          } else if (path.startsWith("/api/v1/cohorts") || path.startsWith("/api/v1/processes") || path.startsWith("/api/v1/tasks") || path.startsWith("/api/v1/me/notifications") || path === "/api/v1/events") {
            expect(response.$ref).toMatch(/^#\/components\/responses\/(?!WorkflowError$)/);
          } else {
            expect(
              derivesFromProblemDetails(schema, document.components.schemas),
              `${path} ${status}: ${JSON.stringify(schema)}`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("wires operation-specific domain error responses", async () => {
    const source = await readFile(
      new URL("../openapi/occ-core.yaml", import.meta.url),
      "utf8",
    );
    const document = parse(source) as OpenApiDocument;
    const expected = [
      ["/api/v1/evidence/upload-sessions", "post", "409", "EvidenceUploadSessionConflict"],
      ["/api/v1/evidence/upload-sessions/{uploadSessionId}/content", "put", "409", "EvidenceContentConflict"],
      ["/api/v1/evidence/upload-sessions/{uploadSessionId}/content", "put", "413", "PayloadTooLarge"],
      ["/api/v1/evidence/upload-sessions/{uploadSessionId}/content", "put", "422", "UnprocessableContent"],
      ["/api/v1/evidence/{evidenceId}/submit", "post", "409", "EvidenceSubmitConflict"],
      ["/api/v1/evidence/{evidenceId}/reviews", "post", "409", "EvidenceReviewCommandConflict"],
      ["/api/v1/risks/{riskId}/actions", "post", "409", "RiskActionConflict"],
      ["/api/v1/risks/adjudications", "post", "409", "RiskAdjudicationConflict"],
      ["/api/v1/resources/{resourceId}", "patch", "409", "ResourceUpdateConflict"],
      ["/api/v1/resources/{resourceId}/availability", "post", "409", "ResourceAvailabilityConflict"],
      ["/api/v1/reservations", "post", "409", "ReservationCreateConflict"],
      ["/api/v1/reservations/{reservationId}/change", "post", "409", "ReservationChangeConflict"],
      ["/api/v1/reservations/{reservationId}/cancel", "post", "409", "ReservationCancelConflict"],
      ["/api/v1/evidence/{evidenceId}/download", "get", "416", "InvalidRange"],
    ] as const;

    for (const [path, method, status, responseName] of expected) {
      const operation = document.paths[path]?.[method as keyof OpenApiPathItem] as OpenApiOperation | undefined;
      expect(operation?.responses?.[status]?.$ref, `${method.toUpperCase()} ${path} ${status}`).toBe(
        `#/components/responses/${responseName}`,
      );
    }
  });

  it("composes endpoint conflict unions from applicable kernel and domain variants", async () => {
    const source = await readFile(
      new URL("../openapi/occ-core.yaml", import.meta.url),
      "utf8",
    );
    const document = parse(source) as OpenApiDocument;
    const schemas = document.components.schemas;
    const idempotency = [
      "IdempotencyConflictProblem",
      "IdempotencyInProgressProblem",
      "IdempotencyExpiredProblem",
    ];
    const expected = {
      EvidenceUploadSessionConflictProblem: [...idempotency, "VersionConflictProblem", "EvidenceUploadConflictProblem"],
      EvidenceContentConflictProblem: [...idempotency, "EvidenceUploadConflictProblem"],
      EvidenceSubmitConflictProblem: [...idempotency, "VersionConflictProblem", "EvidenceUploadConflictProblem"],
      EvidenceReviewCommandConflictProblem: [...idempotency, "VersionConflictProblem", "EvidenceReviewConflictProblem"],
      RiskActionConflictProblem: [...idempotency, "VersionConflictProblem", "RiskInvalidTransitionProblem"],
      RiskAdjudicationConflictProblem: idempotency,
      ResourceUpdateConflictProblem: [...idempotency, "VersionConflictProblem", "ResourceUnavailableProblem", "ReservationConflictProblem"],
      ResourceAvailabilityConflictProblem: [...idempotency, "VersionConflictProblem", "ResourceUnavailableProblem", "ReservationConflictProblem"],
      ReservationCreateConflictProblem: [...idempotency, "ResourceUnavailableProblem", "ReservationConflictProblem"],
      ReservationChangeConflictProblem: [...idempotency, "VersionConflictProblem", "ResourceUnavailableProblem", "ReservationConflictProblem"],
      ReservationCancelConflictProblem: [...idempotency, "VersionConflictProblem"],
    };

    for (const [name, variants] of Object.entries(expected)) {
      expect(schemas[name]?.oneOf, name).toEqual(
        variants.map((variant) => ({ $ref: `#/components/schemas/${variant}` })),
      );
    }
    expect(schemas.RiskAdjudicationConflictProblem?.oneOf).not.toContainEqual({
      $ref: "#/components/schemas/VersionConflictProblem",
    });
  });

  it("documents fixed 503 variants for every protected domain operation", async () => {
    const source = await readFile(
      new URL("../openapi/occ-core.yaml", import.meta.url),
      "utf8",
    );
    const document = parse(source) as OpenApiDocument;
    const domainPrefixes = ["/api/v1/evidence", "/api/v1/risks", "/api/v1/resources", "/api/v1/reservations"];

    for (const [path, pathItem] of Object.entries(document.paths)) {
      if (!domainPrefixes.some((prefix) => path.startsWith(prefix))) continue;
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!HTTP_METHODS.has(method)) continue;
        const command = operation.parameters?.some(
          (parameter) => parameter.$ref === "#/components/parameters/IdempotencyKey",
        );
        expect(operation.responses?.["503"]?.$ref, `${method.toUpperCase()} ${path}`).toBe(
          command
            ? "#/components/responses/CommandUnavailable"
            : "#/components/responses/AuthorizationUnavailable",
        );
      }
    }
    expect(document.components.responses?.AuthorizationUnavailable?.content?.["application/problem+json"]?.schema?.$ref).toBe(
      "#/components/schemas/AuthorizationUnavailableProblem",
    );
    expect(document.components.responses?.CommandUnavailable?.content?.["application/problem+json"]?.schema?.$ref).toBe(
      "#/components/schemas/ProtectedCommandUnavailableProblem",
    );
  });

  it("fixes status and code for every domain Problem Details variant", async () => {
    const source = await readFile(
      new URL("../openapi/occ-core.yaml", import.meta.url),
      "utf8",
    );
    const schemas = (parse(source) as OpenApiDocument).components.schemas;
    const variants = {
      EvidenceUploadConflictProblem: [409, "OCC-EVIDENCE-UPLOAD-CONFLICT"],
      EvidenceReviewConflictProblem: [409, "OCC-EVIDENCE-REVIEW-CONFLICT"],
      RiskInvalidTransitionProblem: [409, "OCC-RISK-INVALID-TRANSITION"],
      ResourceUnavailableProblem: [409, "OCC-RESOURCE-UNAVAILABLE"],
      EvidenceTooLargeProblem: [413, "OCC-EVIDENCE-TOO-LARGE"],
      EvidenceDigestMismatchProblem: [422, "OCC-EVIDENCE-DIGEST-MISMATCH"],
      EvidenceInvalidContentProblem: [422, "OCC-EVIDENCE-INVALID-CONTENT"],
      InvalidRangeProblem: [416, "OCC-INVALID-REQUEST"],
    } as const;
    const base = {
      type: "https://innorder.local/problems/domain-error",
      title: "Domain error",
      correlationId: "11111111-1111-4111-8111-111111111111",
    };

    for (const [name, [status, code]] of Object.entries(variants)) {
      const validate = createOpenApiSchemaValidator(schemas, name);
      expect(validate({ ...base, status, code }), JSON.stringify(validate.errors)).toBe(true);
      expect(validate({ ...base, status: status + 1, code })).toBe(false);
      expect(validate({ ...base, status, code: "OCC-API-INTERNAL" })).toBe(false);
    }
    expect(schemas.UnprocessableContentProblem?.oneOf).toEqual([
      { $ref: "#/components/schemas/EvidenceDigestMismatchProblem" },
      { $ref: "#/components/schemas/EvidenceInvalidContentProblem" },
    ]);

    const validateVersionConflict = createOpenApiSchemaValidator(schemas, "VersionConflictProblem");
    const versionConflict = {
      ...base,
      status: 409,
      code: "OCC-COMMAND-OPTIMISTIC-CONFLICT",
      currentVersion: 3,
    };
    expect(validateVersionConflict(versionConflict), JSON.stringify(validateVersionConflict.errors)).toBe(true);
    expect(validateVersionConflict({ ...versionConflict, currentVersion: undefined })).toBe(false);

    for (const [name, code] of [
      ["AuthorizationUnavailableProblem", "OCC-AUTHZ-UNAVAILABLE"],
      ["CommandIntegrityProblem", "OCC-COMMAND-INTEGRITY"],
    ] as const) {
      const validate = createOpenApiSchemaValidator(schemas, name);
      expect(validate({ ...base, status: 503, code }), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("discriminates typed reservation conflict descriptors and redacts identity", async () => {
    const source = await readFile(
      new URL("../openapi/occ-core.yaml", import.meta.url),
      "utf8",
    );
    const schemas = (parse(source) as OpenApiDocument).components.schemas;
    const descriptor = schemas.ReservationConflictDescriptor;
    const interval = { start: "2026-08-01T10:30:00+02:00", end: "2026-08-01T11:30:00+02:00" };
    const resourceId = "11111111-1111-4111-8111-111111111111";
    const validate = createOpenApiSchemaValidator(schemas, "ReservationConflictProblem");
    const base = {
      type: "https://innorder.local/problems/reservation-conflict",
      title: "Reservation conflict",
      status: 409,
      code: "OCC-RESERVATION-CONFLICT",
      correlationId: resourceId,
    };

    expect(descriptor?.discriminator?.propertyName).toBe("redacted");
    expect(validate({ ...base, conflict: { resourceId, interval, kind: "CAPACITY", redacted: true } })).toBe(true);
    expect(validate({ ...base, conflict: { resourceId, interval, kind: "CAPACITY", redacted: true, reservationId: resourceId } })).toBe(false);
    expect(validate({ ...base, conflict: { resourceId, interval, kind: "CAPACITY", redacted: false, reservationId: resourceId, requesterEntityId: resourceId } })).toBe(true);
    expect(validate(base)).toBe(false);
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
      code: { $ref: "#/components/schemas/BaseProblemCode" },
      correlationId: { type: "string", format: "uuid" },
      detail: {
        type: "string",
        minLength: PROBLEM_DETAIL_MIN_LENGTH,
        maxLength: PROBLEM_DETAIL_MAX_LENGTH,
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
        pattern: EVENT_STABLE_TYPE_PATTERN,
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
        pattern: EVENT_STABLE_TYPE_PATTERN,
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
