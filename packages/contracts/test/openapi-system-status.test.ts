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
  PROBLEM_CODE_MAX_LENGTH,
  PROBLEM_CODE_MIN_LENGTH,
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
  requestBody?: {
    content?: Record<string, { schema?: { $ref?: string } }>;
  };
  security?: Array<Record<string, string[]>>;
  responses?: Record<string, OpenApiResponse>;
}

interface OpenApiResponse {
  content?: Record<string, { schema?: { $ref?: string } }>;
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
      code: {
        type: "string",
        minLength: PROBLEM_CODE_MIN_LENGTH,
        maxLength: PROBLEM_CODE_MAX_LENGTH,
      },
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
