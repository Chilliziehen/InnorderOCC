import { describe, expect, it } from "vitest";

import {
  currentUserSchema,
  eventEnvelopeSchema,
  loginRequestSchema,
  problemDetailsSchema,
  refreshRequestSchema,
  tokenResponseSchema,
} from "../src/index.js";

const id = "550e8400-e29b-41d4-a716-446655440000";
const anotherId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const occurredAt = "2026-07-30T14:15:16.000+02:00";

const currentUser = {
  id,
  username: "pilot.user",
  displayName: "Pilot User",
  status: "ACTIVE",
  capabilities: ["tasks:read", "evidence:submit"],
} as const;

describe("problemDetailsSchema", () => {
  it("parses valid problem details", () => {
    const problem = {
      type: "https://innorder.example/problems/invalid-credentials",
      title: "Invalid credentials",
      status: 401,
      code: "AUTH_INVALID_CREDENTIALS",
      correlationId: id,
      detail: "The supplied username or password was not accepted.",
    };

    expect(problemDetailsSchema.parse(problem)).toEqual(problem);
  });
});

describe("auth contracts", () => {
  const validPassword = "p".repeat(12);

  it("accepts only normalized username-compatible values", () => {
    expect(
      loginRequestSchema.parse({ username: "pilot.user", password: validPassword }),
    ).toEqual({ username: "pilot.user", password: validPassword });
    expect(() =>
      loginRequestSchema.parse({
        username: " Pilot.User ",
        password: validPassword,
      }),
    ).toThrow();
  });

  it("accepts passwords at the 12 and 128 character boundaries", () => {
    for (const length of [12, 128]) {
      const password = "p".repeat(length);

      expect(loginRequestSchema.parse({ username: "pilot.user", password })).toEqual({
        username: "pilot.user",
        password,
      });
    }
  });

  it("rejects passwords outside the 12 to 128 character boundaries", () => {
    for (const length of [11, 129]) {
      expect(() =>
        loginRequestSchema.parse({
          username: "pilot.user",
          password: "p".repeat(length),
        }),
      ).toThrow();
    }
  });

  it.each([
    [
      loginRequestSchema,
      { username: "pilot.user", password: validPassword, otp: "123456" },
    ],
    [refreshRequestSchema, { refreshToken: "opaque-token", accessToken: "secret" }],
    [currentUserSchema, { ...currentUser, passwordHash: "secret" }],
    [
      tokenResponseSchema,
      {
        tokenType: "Bearer",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresIn: 900,
        user: currentUser,
        clientSecret: "secret",
      },
    ],
  ])("rejects unknown fields in auth contract %#", (schema, value) => {
    expect(schema).toBeDefined();
    expect(() => schema.parse(value)).toThrow();
  });
});

describe("eventEnvelopeSchema", () => {
  const event = {
    id,
    customerInstanceId: anotherId,
    type: "TaskClaimed",
    schemaVersion: 1,
    aggregateType: "Task",
    aggregateId: id,
    aggregateVersion: 0,
    occurredAt,
    actorId: anotherId,
    correlationId: id,
    causationId: anotherId,
    payload: { taskId: id },
  };

  it("parses a versioned event with UUIDs and an ISO offset instant", () => {
    expect(eventEnvelopeSchema.parse(event)).toEqual(event);
  });

  it("rejects unknown envelope fields", () => {
    expect(eventEnvelopeSchema).toBeDefined();
    expect(() =>
      eventEnvelopeSchema.parse({ ...event, password: "must-not-leak" }),
    ).toThrow();
  });
});
