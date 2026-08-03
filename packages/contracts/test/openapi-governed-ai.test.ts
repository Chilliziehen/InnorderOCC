import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

import {
  STABLE_AI_ERROR_CODE_PATTERN,
  aiGrantClaimsSchema,
  aiGuidanceRequestedPayloadSchema,
  aiOperationDeadLetteredPayloadSchema,
  aiRecommendationProposedPayloadSchema,
  capabilityProbeRequestSchema,
  capabilityProbeSchema,
  capabilitySnapshotSchema,
  citationSchema,
  generatedRecommendationSchema,
  guidanceRequestSchema,
  guidanceStatusSchema,
  guidanceStepSchema,
  knowledgeActivationRequestSchema,
  knowledgeGateMetricsSchema,
  knowledgeGateResultSchema,
  knowledgeIngestionJobSchema,
  knowledgeIngestionRequestedPayloadSchema,
  knowledgeRollbackRequestSchema,
  knowledgeUploadMetadataSchema,
  providerConfigCreateSchema,
  providerConfigListSchema,
  providerConfigSchema,
  providerConfigUpdateSchema,
  providerCostRuleSchema,
  providerProfileCreateSchema,
  providerProfileListSchema,
  providerProfileSchema,
  providerProfileUpdateSchema,
  providerRateLimitSchema,
  providerTimeoutsSchema,
  recommendationDetailSchema,
  recommendationItemSchema,
  recommendationListSchema,
  recommendationReviewRequestSchema,
  requiredProviderCapabilitiesSchema,
  serviceGrantClaimSchema,
  serviceGrantExchangeSchema,
  serviceIngestionOutcomeSchema,
  serviceOperationOutcomeSchema,
  serviceProviderProbeOutcomeSchema,
  serviceRecommendationSubmissionSchema,
} from "../src/index.js";

type Schema = {
  "x-occ-validation"?: string[];
  additionalProperties?: boolean;
  description?: string;
  dependentRequired?: Record<string, string[]>;
  properties?: Record<string, Record<string, unknown>>;
  required?: string[];
  type?: string;
};
type Parameter = { $ref?: string; in?: string; name?: string; required?: boolean; schema?: Record<string, unknown> };
type Operation = {
  description?: string;
  parameters?: Parameter[];
  requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> };
  responses?: Record<string, { $ref?: string; content?: Record<string, { schema?: { $ref?: string } }> }>;
  security?: Array<Record<string, string[]>>;
};
type Document = {
  components: {
    parameters: Record<string, Parameter>;
    responses: Record<string, { content?: Record<string, { schema?: { $ref?: string } }> }>;
    schemas: Record<string, Schema>;
    securitySchemes: Record<string, unknown>;
  };
  paths: Record<string, Record<string, Operation>>;
};

const PATHS = [
  ["/api/v1/admin/ai/providers", "get"],
  ["/api/v1/admin/ai/providers", "post"],
  ["/api/v1/admin/ai/providers/{providerId}", "get"],
  ["/api/v1/admin/ai/providers/{providerId}", "patch"],
  ["/api/v1/admin/ai/provider-profiles", "get"],
  ["/api/v1/admin/ai/provider-profiles", "post"],
  ["/api/v1/admin/ai/provider-profiles/{profileId}", "get"],
  ["/api/v1/admin/ai/provider-profiles/{profileId}", "patch"],
  ["/api/v1/admin/ai/providers/{providerId}/probes", "post"],
  ["/api/v1/admin/ai/providers/{providerId}/probes/{probeId}", "get"],
  ["/api/v1/admin/ai/knowledge/uploads", "post"],
  ["/api/v1/admin/ai/knowledge/ingestions/{jobId}", "get"],
  ["/api/v1/admin/ai/knowledge/spaces/{spaceId}/activate", "post"],
  ["/api/v1/admin/ai/knowledge/spaces/{spaceId}/rollback", "post"],
  ["/api/v1/ai/guidance", "post"],
  ["/api/v1/ai/guidance/{operationId}", "get"],
  ["/api/v1/ai/recommendations", "get"],
  ["/api/v1/ai/recommendations/{recommendationId}", "get"],
  ["/api/v1/ai/recommendations/{recommendationId}/review", "post"],
  ["/internal/v1/ai/grants/claim", "post"],
  ["/internal/v1/ai/recommendations", "post"],
  ["/internal/v1/ai/knowledge/ingestions/{jobId}/outcome", "post"],
  ["/internal/v1/ai/providers/probes/{probeId}/outcome", "post"],
  ["/internal/v1/ai/operations/{operationId}/outcome", "post"],
] as const;

const OBJECT_SCHEMA_PARITY = [
  ["AiGrantClaims", aiGrantClaimsSchema],
  ["ProviderConfig", providerConfigSchema],
  ["ProviderConfigCreate", providerConfigCreateSchema],
  ["ProviderConfigList", providerConfigListSchema],
  ["ProviderConfigUpdate", providerConfigUpdateSchema],
  ["ProviderTimeouts", providerTimeoutsSchema],
  ["ProviderRateLimit", providerRateLimitSchema],
  ["ProviderCostRule", providerCostRuleSchema],
  ["RequiredProviderCapabilities", requiredProviderCapabilitiesSchema],
  ["CapabilitySnapshot", capabilitySnapshotSchema],
  ["ProviderProfile", providerProfileSchema],
  ["ProviderProfileCreate", providerProfileCreateSchema],
  ["ProviderProfileList", providerProfileListSchema],
  ["ProviderProfileUpdate", providerProfileUpdateSchema],
  ["CapabilityProbeRequest", capabilityProbeRequestSchema],
  ["CapabilityProbe", capabilityProbeSchema],
  ["KnowledgeUploadMetadata", knowledgeUploadMetadataSchema],
  ["KnowledgeIngestionJob", knowledgeIngestionJobSchema],
  ["KnowledgeGateMetrics", knowledgeGateMetricsSchema],
  ["KnowledgeGateResult", knowledgeGateResultSchema],
  ["KnowledgeActivationRequest", knowledgeActivationRequestSchema],
  ["KnowledgeRollbackRequest", knowledgeRollbackRequestSchema],
  ["GuidanceRequest", guidanceRequestSchema],
  ["GuidanceStatus", guidanceStatusSchema],
  ["Citation", citationSchema],
  ["GuidanceStep", guidanceStepSchema],
  ["GeneratedRecommendation", generatedRecommendationSchema],
  ["RecommendationItem", recommendationItemSchema],
  ["RecommendationList", recommendationListSchema],
  ["RecommendationDetail", recommendationDetailSchema],
  ["RecommendationReviewRequest", recommendationReviewRequestSchema],
  ["ServiceGrantClaim", serviceGrantClaimSchema],
  ["ServiceGrantExchange", serviceGrantExchangeSchema],
  ["ServiceRecommendationSubmission", serviceRecommendationSubmissionSchema],
  ["ServiceOperationOutcome", serviceOperationOutcomeSchema],
  ["ServiceIngestionOutcome", serviceIngestionOutcomeSchema],
  ["ServiceProviderProbeOutcome", serviceProviderProbeOutcomeSchema],
  ["KnowledgeIngestionRequestedPayload", knowledgeIngestionRequestedPayloadSchema],
  ["AiGuidanceRequestedPayload", aiGuidanceRequestedPayloadSchema],
  ["AiRecommendationProposedPayload", aiRecommendationProposedPayloadSchema],
  ["AiOperationDeadLetteredPayload", aiOperationDeadLetteredPayloadSchema],
] as const;

const GOVERNED_SCHEMA_MANIFEST = [
  "DataClassification",
  "ProviderPurpose",
  ...OBJECT_SCHEMA_PARITY.map(([name]) => name),
] as const;

const SEMANTIC_VALIDATION_IDS = {
  AiGrantClaims: ["grant-lifetime"],
  ProviderTimeouts: ["timeout-order"],
  ProviderProfile: ["profile-purpose-capability-compatibility"],
  ProviderProfileCreate: ["profile-purpose-capability-compatibility"],
  ProviderProfileUpdate: ["profile-purpose-capability-compatibility"],
  KnowledgeIngestionJob: ["ingestion-attempt-and-time-consistency"],
  KnowledgeGateMetrics: ["gate-arithmetic-consistency"],
  KnowledgeGateResult: ["gate-arithmetic-consistency"],
  GeneratedRecommendation: ["citation-referential-integrity"],
} as const;

const EXPRESSIBLE_VALIDATION_SCHEMAS = [
  "CapabilitySnapshot",
  "CapabilityProbe",
  "GuidanceStatus",
  "ServiceOperationOutcome",
  "ServiceIngestionOutcome",
  "ServiceProviderProbeOutcome",
] as const;

const requiredKeys = (shape: Record<string, { isOptional: () => boolean }>): string[] =>
  Object.entries(shape).filter(([, value]) => !value.isOptional()).map(([key]) => key);

const VALIDATION_KEYWORDS = [
  "type",
  "format",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "enum",
  "const",
  "minItems",
  "maxItems",
  "uniqueItems",
] as const;

describe("OCC Core governed AI OpenAPI", () => {
  let document: Document;

  beforeAll(async () => {
    document = parse(await readFile(new URL("../openapi/occ-core.yaml", import.meta.url), "utf8")) as Document;
  });

  it("publishes every versioned administration, guidance, review, and service endpoint", () => {
    for (const [path, method] of PATHS) expect(document.paths[path]?.[method]).toBeDefined();
  });

  it("requires Idempotency-Key on every mutation and expectedVersion on updates", () => {
    for (const [path, method] of PATHS.filter(([, method]) => method !== "get")) {
      const parameters = document.paths[path]?.[method]?.parameters ?? [];
      expect(parameters.some((parameter) => parameter.$ref === "#/components/parameters/IdempotencyKey")).toBe(true);
    }
    expect(document.components.parameters.IdempotencyKey).toMatchObject({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      schema: { type: "string", minLength: 1, maxLength: 128 },
    });
    for (const [path, method] of [
      ["/api/v1/admin/ai/providers/{providerId}", "patch"],
      ["/api/v1/admin/ai/provider-profiles/{profileId}", "patch"],
      ["/api/v1/admin/ai/knowledge/spaces/{spaceId}/activate", "post"],
      ["/api/v1/admin/ai/knowledge/spaces/{spaceId}/rollback", "post"],
      ["/api/v1/ai/recommendations/{recommendationId}/review", "post"],
      ["/internal/v1/ai/knowledge/ingestions/{jobId}/outcome", "post"],
      ["/internal/v1/ai/providers/probes/{probeId}/outcome", "post"],
      ["/internal/v1/ai/operations/{operationId}/outcome", "post"],
    ] as const) {
      const schemaRef = document.paths[path]?.[method]?.requestBody?.content?.["application/json"]?.schema?.$ref;
      const schema = document.components.schemas[schemaRef?.split("/").at(-1) ?? ""];
      expect(schema?.properties).toHaveProperty("expectedVersion");
      expect(schema?.required).toContain("expectedVersion");
    }
  });

  it("bounds every governed list cursor", () => {
    for (const path of [
      "/api/v1/admin/ai/providers",
      "/api/v1/admin/ai/provider-profiles",
      "/api/v1/ai/recommendations",
    ]) {
      const parameters = document.paths[path]?.get?.parameters ?? [];
      expect(parameters.find((parameter) => parameter.name === "cursor")).toMatchObject({
        in: "query",
        required: false,
        schema: { type: "string", minLength: 1, maxLength: 1024 },
      });
      expect(parameters.find((parameter) => parameter.name === "limit")).toMatchObject({
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 100 },
      });
    }
  });

  it("marks service routes mTLS-only and explicitly rejects bearer credentials", () => {
    expect(document.components.securitySchemes.mtlsAuth).toEqual({ type: "mutualTLS" });
    for (const [path, method] of PATHS.filter(([path]) => path.startsWith("/internal/"))) {
      const operation = document.paths[path]?.[method];
      expect(operation?.security).toEqual([{ mtlsAuth: [] }]);
      expect(operation?.description).toMatch(/rejects? bearer/i);
    }
  });

  it("uses RFC 9457 Problem Details for every governed operation error", () => {
    for (const response of Object.values(document.components.responses)) {
      expect(response.content?.["application/problem+json"]?.schema?.$ref).toBe("#/components/schemas/ProblemDetails");
    }
    for (const [path, method] of PATHS) {
      const errors = Object.entries(document.paths[path]?.[method]?.responses ?? {}).filter(([status]) => /^[45]/.test(status));
      expect(errors.length).toBeGreaterThan(0);
      for (const [, response] of errors) expect(response.$ref).toMatch(/^#\/components\/responses\//);
    }
  });

  it("keeps every governed OpenAPI object strict and aligned with Zod", () => {
    const schemaNames = Object.keys(document.components.schemas);
    expect(schemaNames.slice(schemaNames.indexOf("DataClassification")).sort()).toEqual(
      [...GOVERNED_SCHEMA_MANIFEST].sort(),
    );
    for (const [name, zodSchema] of OBJECT_SCHEMA_PARITY) {
      const schema = document.components.schemas[name];
      expect(schema?.type).toBe("object");
      expect(schema?.additionalProperties).toBe(false);
      expect(Object.keys(schema?.properties ?? {})).toEqual(Object.keys(zodSchema.shape));
      expect(schema?.required).toEqual(requiredKeys(zodSchema.shape));
    }
  });

  it("matches every expressible governed property constraint from Zod", () => {
    const resolve = (schema: Record<string, unknown>): Record<string, unknown> => {
      const reference = schema.$ref;
      if (typeof reference !== "string") return schema;
      const name = reference.split("/").at(-1) ?? "";
      return document.components.schemas[name] as unknown as Record<string, unknown>;
    };
    const compare = (
      actualInput: Record<string, unknown>,
      expected: Record<string, unknown>,
      path: string,
    ): void => {
      const actual = resolve(actualInput);
      for (const keyword of VALIDATION_KEYWORDS) {
        if (expected[keyword] === undefined) continue;
        if (keyword === "type" && expected[keyword] === "number" && actual[keyword] === "integer") continue;
        expect(actual[keyword], `${path}.${keyword}`).toEqual(expected[keyword]);
      }
      const expectedFormat = expected.format;
      if (
        typeof expected.pattern === "string" &&
        expectedFormat !== "uuid" &&
        expectedFormat !== "date-time" &&
        expectedFormat !== "cidrv4" &&
        expectedFormat !== "cidrv6"
      ) {
        expect(typeof actual.pattern, `${path}.pattern`).toBe("string");
        expect(new RegExp(actual.pattern as string).source, `${path}.pattern`).toBe(
          new RegExp(expected.pattern).source,
        );
      }
      if (Array.isArray(expected.anyOf) && Array.isArray(actual.anyOf)) {
        expect(actual.anyOf, `${path}.anyOf length`).toHaveLength(expected.anyOf.length);
        expected.anyOf.forEach((entry, index) => compare(
          (actual.anyOf as Record<string, unknown>[])[index] ?? {},
          entry as Record<string, unknown>,
          `${path}.anyOf[${index}]`,
        ));
      }
      if (
        expected.items !== undefined &&
        actual.items !== undefined &&
        !Array.isArray(expected.items) &&
        !Array.isArray(actual.items)
      ) {
        compare(
          actual.items as Record<string, unknown>,
          expected.items as Record<string, unknown>,
          `${path}.items`,
        );
      }
    };

    for (const [name, zodSchema] of OBJECT_SCHEMA_PARITY) {
      const expected = z.toJSONSchema(zodSchema) as Record<string, unknown>;
      const expectedProperties = expected.properties as Record<string, Record<string, unknown>>;
      const actualProperties = document.components.schemas[name]?.properties ?? {};
      for (const [property, expectedProperty] of Object.entries(expectedProperties)) {
        compare(actualProperties[property] ?? {}, expectedProperty, `${name}.${property}`);
      }
    }
  });

  it("preserves provider and profile scalar bounds and patterns", () => {
    const expectedFields = {
      ProviderConfig: {
        name: { type: "string", minLength: 1, maxLength: 128 },
        origin: { type: "string", format: "uri", minLength: 9, maxLength: 2048, pattern: "^https://(?![^/?#]*@)[^/?#]+$" },
        apiPrefix: { type: "string", minLength: 1, maxLength: 256, pattern: "^/(?:[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*)?$" },
        credentialFile: { type: "string", minLength: 1, maxLength: 1024, pattern: "^(?:/|[A-Za-z]:\\\\)" },
      },
      ProviderProfile: {
        name: { type: "string", minLength: 1, maxLength: 128 },
        model: { type: "string", minLength: 1, maxLength: 256 },
      },
    } as const;
    for (const [name, fields] of Object.entries(expectedFields)) {
      for (const [field, expected] of Object.entries(fields)) {
        expect(document.components.schemas[name]?.properties?.[field]).toMatchObject(expected);
      }
    }
    for (const name of ["ProviderConfigCreate", "ProviderConfigUpdate"]) {
      for (const field of ["name", "origin", "apiPrefix", "credentialFile"]) {
        expect(document.components.schemas[name]?.properties?.[field]).toEqual(
          document.components.schemas.ProviderConfig?.properties?.[field],
        );
      }
    }
    for (const name of ["ProviderProfileCreate", "ProviderProfileUpdate"]) {
      for (const field of ["name", "model"]) {
        expect(document.components.schemas[name]?.properties?.[field]).toEqual(
          document.components.schemas.ProviderProfile?.properties?.[field],
        );
      }
    }
  });

  it("documents exact provider origin and normalized prefix semantic validation", () => {
    const provider = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "Provider",
      origin: "https://models.example.test",
      apiPrefix: "/v1",
      approvedPrivateCidrs: [],
      credentialFile: "/run/secrets/provider-key",
      enabled: true,
      version: 0,
    };
    expect(() => providerConfigSchema.parse({ ...provider, origin: "https://user@models.example.test" })).toThrow();
    expect(() => providerConfigSchema.parse({ ...provider, apiPrefix: "/v1/../admin" })).toThrow();

    const expectedOriginValidation = {
      kind: "exact-https-origin",
      requirements: ["https-only", "no-userinfo", "origin-only", "canonical-origin"],
    };
    const expectedPrefixValidation = {
      kind: "normalized-api-prefix",
      requirements: ["single-leading-slash", "no-trailing-slash", "no-dot-segments", "no-encoded-separators"],
    };
    for (const name of ["ProviderConfig", "ProviderConfigCreate", "ProviderConfigUpdate"]) {
      expect(document.components.schemas[name]?.properties?.origin?.["x-occ-validation"]).toEqual(expectedOriginValidation);
      expect(document.components.schemas[name]?.properties?.apiPrefix?.["x-occ-validation"]).toEqual(expectedPrefixValidation);
    }
  });

  it("aligns the dead-letter error code with the shared stable schema", () => {
    expect(document.components.schemas.AiOperationDeadLetteredPayload?.properties?.errorCode).toMatchObject({
      type: "string",
      pattern: STABLE_AI_ERROR_CODE_PATTERN,
    });
  });

  it("requires complete capability context when a profile model changes", () => {
    expect(document.components.schemas.ProviderProfileUpdate?.dependentRequired).toEqual({
      model: ["purpose", "requiredCapabilities", "capabilitySnapshot"],
      purpose: ["requiredCapabilities", "capabilitySnapshot"],
      requiredCapabilities: ["purpose", "capabilitySnapshot"],
      capabilitySnapshot: ["purpose", "requiredCapabilities"],
    });
  });

  it("encodes CIDR syntax and approved-private containment directly", () => {
    for (const name of ["ProviderConfig", "ProviderConfigCreate", "ProviderConfigUpdate"]) {
      const cidrs = document.components.schemas[name]?.properties?.approvedPrivateCidrs;
      expect(cidrs?.["x-occ-validation"]).toBeUndefined();
      expect(cidrs?.items).toMatchObject({
        anyOf: [
          { type: "string", format: "cidrv4", pattern: expect.any(String) },
          { type: "string", format: "cidrv6", pattern: expect.any(String) },
        ],
      });
    }
  });

  it("preserves stale-reason enums in list and detail contracts", () => {
    const expected = [
      "PACKAGE_VERSION_CHANGED",
      "POLICY_RELEASE_CHANGED",
      "DOCUMENT_VERSION_CHANGED",
      "PROVIDER_CAPABILITY_CHANGED",
      "TARGET_VERSION_CHANGED",
      "AI_UNAVAILABLE",
    ];
    for (const name of ["RecommendationItem", "RecommendationDetail"]) {
      expect(document.components.schemas[name]?.properties?.staleReasons?.items).toMatchObject({
        type: "string",
        enum: expected,
      });
    }
  });

  it("declares every semantic refinement that JSON Schema cannot express", () => {
    for (const [name, ids] of Object.entries(SEMANTIC_VALIDATION_IDS)) {
      expect(document.components.schemas[name]?.["x-occ-validation"]).toEqual(ids);
    }
    for (const name of EXPRESSIBLE_VALIDATION_SCHEMAS) {
      expect(document.components.schemas[name]?.["x-occ-validation"]).toBeUndefined();
    }
    const ingestionJob = document.components.schemas.KnowledgeIngestionJob;
    expect(ingestionJob?.properties?.sanitizedError).toBeUndefined();
    expect(ingestionJob?.properties?.errorCode).toMatchObject({
      type: "string",
      minLength: 8,
      maxLength: 119,
      pattern: STABLE_AI_ERROR_CODE_PATTERN,
    });
    expect(ingestionJob?.description).toContain("maps internal V015 sanitized_error details");
    expect(ingestionJob?.description).toContain("never serialized");
  });
});
