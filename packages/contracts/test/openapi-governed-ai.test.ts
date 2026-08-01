import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  generatedRecommendationSchema,
  guidanceRequestSchema,
  knowledgeActivationRequestSchema,
  providerConfigSchema,
  recommendationReviewRequestSchema,
  serviceGrantClaimSchema,
} from "../src/index.js";

type Schema = {
  additionalProperties?: boolean;
  properties?: Record<string, unknown>;
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
  ["/api/v1/admin/ai/providers", "post"],
  ["/api/v1/admin/ai/providers/{providerId}", "patch"],
  ["/api/v1/admin/ai/provider-profiles", "post"],
  ["/api/v1/admin/ai/provider-profiles/{profileId}", "patch"],
  ["/api/v1/admin/ai/providers/{providerId}/probes", "post"],
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
  ["/internal/v1/ai/operations/{operationId}/outcome", "post"],
] as const;

const requiredKeys = (shape: Record<string, { isOptional: () => boolean }>): string[] =>
  Object.entries(shape).filter(([, value]) => !value.isOptional()).map(([key]) => key);

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
    ] as const) {
      const schemaRef = document.paths[path]?.[method]?.requestBody?.content?.["application/json"]?.schema?.$ref;
      const schema = document.components.schemas[schemaRef?.split("/").at(-1) ?? ""];
      expect(schema?.properties).toHaveProperty("expectedVersion");
      expect(schema?.required).toContain("expectedVersion");
    }
  });

  it("bounds recommendation cursors", () => {
    const parameters = document.paths["/api/v1/ai/recommendations"]?.get?.parameters ?? [];
    expect(parameters.find((parameter) => parameter.name === "cursor")).toMatchObject({
      in: "query",
      required: false,
      schema: { type: "string", minLength: 1, maxLength: 1024 },
    });
    expect(parameters.find((parameter) => parameter.name === "limit")).toMatchObject({
      in: "query",
      schema: { type: "integer", minimum: 1, maximum: 100 },
    });
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

  it("keeps key OpenAPI object fields strict and aligned with Zod", () => {
    for (const [name, shape] of [
      ["ProviderConfig", providerConfigSchema.shape],
      ["KnowledgeActivationRequest", knowledgeActivationRequestSchema.shape],
      ["GuidanceRequest", guidanceRequestSchema.shape],
      ["GeneratedRecommendation", generatedRecommendationSchema.shape],
      ["RecommendationReviewRequest", recommendationReviewRequestSchema.shape],
      ["ServiceGrantClaim", serviceGrantClaimSchema.shape],
    ] as const) {
      const schema = document.components.schemas[name];
      expect(schema?.type).toBe("object");
      expect(schema?.additionalProperties).toBe(false);
      expect(Object.keys(schema?.properties ?? {})).toEqual(Object.keys(shape));
      expect(schema?.required).toEqual(requiredKeys(shape));
    }
  });
});
