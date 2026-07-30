import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  ComponentStatusSchema,
  ServiceStateSchema,
  SystemStatusSchema,
} from "../src/system-status.js";

interface OpenApiSchema {
  additionalProperties?: boolean;
  enum?: string[];
  properties?: Record<string, OpenApiSchemaProperty>;
  required?: string[];
}

interface OpenApiSchemaProperty {
  $ref?: string;
  format?: string;
  items?: { $ref?: string };
  maxLength?: number;
  minLength?: number;
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
