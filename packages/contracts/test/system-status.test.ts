import { describe, expect, it } from "vitest";

import {
  ComponentStatusSchema,
  ProviderCapabilitySchema,
  ServiceStateSchema,
  SystemStatusSchema,
} from "../src/system-status.js";

const checkedAt = "2026-07-28T12:34:56.789Z";

describe("ServiceStateSchema", () => {
  it.each(["READY", "DEGRADED", "UNREACHABLE", "CHECKING"])(
    "accepts %s",
    (state) => {
      expect(ServiceStateSchema.parse(state)).toBe(state);
    },
  );

  it("rejects unsupported states", () => {
    expect(() => ServiceStateSchema.parse("UNKNOWN")).toThrow();
  });
});

describe("ComponentStatusSchema", () => {
  it("accepts a component with an ISO timestamp", () => {
    expect(
      ComponentStatusSchema.parse({
        id: "database",
        label: "Database",
        state: "READY",
        detail: "Connected",
        checkedAt,
      }),
    ).toEqual({
      id: "database",
      label: "Database",
      state: "READY",
      detail: "Connected",
      checkedAt,
    });
  });

  it("rejects invalid timestamps and unknown fields", () => {
    expect(() =>
      ComponentStatusSchema.parse({
        id: "database",
        label: "Database",
        state: "READY",
        checkedAt: "July 28, 2026",
      }),
    ).toThrow();

    expect(() =>
      ComponentStatusSchema.parse({
        id: "database",
        label: "Database",
        state: "READY",
        checkedAt,
        secret: "must not pass through",
      }),
    ).toThrow();
  });
});

describe("SystemStatusSchema", () => {
  const status = {
    service: "occ-core",
    version: "0.1.0",
    state: "DEGRADED",
    checkedAt,
    components: [
      {
        id: "database",
        label: "Database",
        state: "UNREACHABLE",
        checkedAt,
      },
    ],
  };

  it("accepts the Core system-status response", () => {
    expect(SystemStatusSchema.parse(status)).toEqual(status);
  });

  it("rejects unknown response fields", () => {
    expect(() =>
      SystemStatusSchema.parse({ ...status, internalCode: "not-public" }),
    ).toThrow();
  });
});

describe("ProviderCapabilitySchema", () => {
  it("accepts an AI provider capability", () => {
    const capability = {
      provider: "openai",
      models: ["gpt-5"],
      supportsTools: true,
      supportsStructuredOutput: true,
    };

    expect(ProviderCapabilitySchema.parse(capability)).toEqual(capability);
  });

  it("rejects unknown capability fields", () => {
    expect(() =>
      ProviderCapabilitySchema.parse({
        provider: "openai",
        models: ["gpt-5"],
        supportsTools: true,
        supportsStructuredOutput: true,
        apiKey: "must not pass through",
      }),
    ).toThrow();
  });
});
