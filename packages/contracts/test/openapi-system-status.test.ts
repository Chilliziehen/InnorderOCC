import { readFile } from "node:fs/promises";

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

interface OpenApiSchema extends OpenApiSchemaProperty {
  additionalProperties?: boolean;
  properties?: Record<string, OpenApiSchemaProperty>;
  required?: string[];
}

interface OpenApiSchemaProperty {
  $ref?: string;
  additionalProperties?: boolean;
  const?: string;
  enum?: string[];
  format?: string;
  items?: OpenApiSchemaProperty;
  maxLength?: number;
  maximum?: number;
  minLength?: number;
  minimum?: number;
  pattern?: string;
  type?: string;
}

interface OpenApiDocument {
  components: {
    responses?: Record<
      string,
      { content?: Record<string, { schema?: { $ref?: string } }> }
    >;
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
  requestBody?: {
    content?: Record<string, { schema?: { $ref?: string } }>;
  };
  security?: Array<Record<string, string[]>>;
  responses?: Record<
    string,
    {
      content?: Record<string, { schema?: { $ref?: string } }>;
      $ref?: string;
    }
  >;
}

const requiredKeys = (
  shape: Record<string, { isOptional: () => boolean }>,
): string[] =>
  Object.entries(shape)
    .filter(([, schema]) => !schema.isOptional())
    .map(([key]) => key);

const expectStrictObjectParity = (
  openApiSchema: OpenApiSchema | undefined,
  zodShape: Record<string, { isOptional: () => boolean }>,
): void => {
  expect(openApiSchema?.type).toBe("object");
  expect(openApiSchema?.additionalProperties).toBe(false);
  expect(openApiSchema?.required).toEqual(requiredKeys(zodShape));
  expect(Object.keys(openApiSchema?.properties ?? {})).toEqual(
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
      minLength: 12,
      maxLength: 128,
    });

    for (const response of Object.values(document.components.responses ?? {})) {
      expect(response.content?.["application/problem+json"]?.schema?.$ref).toBe(
        "#/components/schemas/ProblemDetails",
      );
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
      title: { type: "string", minLength: 1, maxLength: 256 },
      status: { type: "integer", minimum: 400, maximum: 599 },
      code: { type: "string", minLength: 1, maxLength: 128 },
      correlationId: { type: "string", format: "uuid" },
      detail: { type: "string", maxLength: 4096 },
    });

    expectStrictObjectParity(schemas.LoginRequest, loginRequestSchema.shape);
    expect(schemas.LoginRequest?.properties).toEqual({
      username: {
        type: "string",
        minLength: 1,
        maxLength: 128,
        pattern: "^(?=.*[!-~])[ -~]{1,128}$",
      },
      password: { type: "string", minLength: 12, maxLength: 128 },
    });

    expectStrictObjectParity(schemas.RefreshRequest, refreshRequestSchema.shape);
    expect(schemas.RefreshRequest?.properties).toEqual({
      refreshToken: {
        type: "string",
        minLength: 43,
        maxLength: 43,
        pattern: "^[A-Za-z0-9_-]{43}$",
      },
    });

    expectStrictObjectParity(schemas.CurrentUser, currentUserSchema.shape);
    expect(schemas.CurrentUser?.properties).toEqual({
      id: { type: "string", format: "uuid" },
      username: { type: "string", minLength: 1, maxLength: 128 },
      displayName: { type: "string", minLength: 1, maxLength: 256 },
      status: {
        type: "string",
        enum: ["ACTIVE", "LOCKED", "DISABLED", "ARCHIVED"],
      },
      capabilities: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 128 },
      },
    });

    expectStrictObjectParity(schemas.TokenResponse, tokenResponseSchema.shape);
    expect(schemas.TokenResponse?.properties).toEqual({
      tokenType: { type: "string", const: "Bearer" },
      accessToken: { type: "string", minLength: 1, maxLength: 8192 },
      refreshToken: {
        type: "string",
        minLength: 43,
        maxLength: 43,
        pattern: "^[A-Za-z0-9_-]{43}$",
      },
      expiresIn: {
        type: "integer",
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      user: { $ref: "#/components/schemas/CurrentUser" },
    });

    expectStrictObjectParity(schemas.EventEnvelope, eventEnvelopeSchema.shape);
    expect(schemas.EventEnvelope?.properties).toEqual({
      id: { type: "string", format: "uuid" },
      customerInstanceId: { type: "string", format: "uuid" },
      type: { type: "string", minLength: 1, maxLength: 256 },
      schemaVersion: {
        type: "integer",
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      aggregateType: { type: "string", minLength: 1, maxLength: 256 },
      aggregateId: { type: "string", format: "uuid" },
      aggregateVersion: {
        type: "integer",
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      occurredAt: { type: "string", format: "date-time" },
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
