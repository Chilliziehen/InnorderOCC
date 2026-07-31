import { describe, expect, it } from "vitest";

import {
  authorizationDecisionSchema,
  authorizationInputSchema,
  currentUserSchema,
  eventEnvelopeSchema,
  loginRequestSchema,
  problemDetailsSchema,
  refreshRequestSchema,
  tokenResponseSchema,
} from "../src/index.js";
import {
  ACTION_KEY_MAX_LENGTH,
  CONTEXT_MAX_PROPERTIES,
  CONTEXT_MAX_SERIALIZED_LENGTH,
  FORBIDDEN_ACTIONS_MAX_LENGTH,
  GRANT_ID_MAX_LENGTH,
  GRANTS_MAX_LENGTH,
} from "../src/authorization.js";
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
  REFRESH_TOKEN_LENGTH,
} from "../src/auth.js";
import {
  EVENT_AGGREGATE_TYPE_MAX_LENGTH,
  EVENT_AGGREGATE_TYPE_MIN_LENGTH,
  EVENT_AGGREGATE_VERSION_MAX,
  EVENT_AGGREGATE_VERSION_MIN,
  EVENT_SCHEMA_VERSION_MAX,
  EVENT_SCHEMA_VERSION_MIN,
  EVENT_TYPE_MAX_LENGTH,
  EVENT_TYPE_MIN_LENGTH,
} from "../src/events.js";
import {
  PROBLEM_CODE_MAX_LENGTH,
  PROBLEM_CODE_MIN_LENGTH,
  PROBLEM_DETAIL_MAX_LENGTH,
  PROBLEM_STATUS_MAX,
  PROBLEM_STATUS_MIN,
  PROBLEM_TITLE_MAX_LENGTH,
  PROBLEM_TITLE_MIN_LENGTH,
} from "../src/problem-details.js";

const id = "550e8400-e29b-41d4-a716-446655440000";
const anotherId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const occurredAt = "2026-07-30T14:15:16.000+02:00";
const refreshToken = `${"A".repeat(REFRESH_TOKEN_LENGTH - 2)}_-`;

const authorizationInput = {
  contractVersion: 1,
  requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  authorizationRevision: 17,
  releases: {
    PLATFORM: id,
    DOMAIN: anotherId,
    CUSTOMER: "123e4567-e89b-42d3-a456-426614174000",
  },
  principal: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", enabled: true },
  entity: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
  action: "resource.read",
  resource: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", active: true },
  context: { correlationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
  forbiddenActions: ["resource.delete"],
  grants: [
    {
      id: "platform-allow",
      layer: "PLATFORM",
      effect: "ALLOW",
      action: "resource.read",
      principalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      entityId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      resourceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    },
  ],
} as const;

describe("authorization contracts", () => {
  it("parses the exact version-1 input and decision envelopes", () => {
    expect(authorizationInputSchema.parse(authorizationInput)).toEqual(authorizationInput);
    const decision = {
      contractVersion: 1,
      requestId: authorizationInput.requestId,
      authorizationRevision: authorizationInput.authorizationRevision,
      releases: authorizationInput.releases,
      decision: "ALLOW",
      allow: true,
      reasonCodes: ["ALLOW_GRANT_MATCH"],
      reasonIds: ["grant:abc"],
      matchedPolicyIds: ["grant:abc"],
    } as const;
    expect(authorizationDecisionSchema.parse(decision)).toEqual(decision);
  });

  it("rejects unknown fields throughout the input", () => {
    for (const invalid of [
      { ...authorizationInput, secret: true },
      { ...authorizationInput, releases: { ...authorizationInput.releases, OTHER: id } },
      { ...authorizationInput, principal: { ...authorizationInput.principal, secret: true } },
      { ...authorizationInput, entity: { ...authorizationInput.entity, secret: true } },
      { ...authorizationInput, resource: { ...authorizationInput.resource, secret: true } },
      { ...authorizationInput, grants: [{ ...authorizationInput.grants[0], secret: true }] },
    ]) expect(() => authorizationInputSchema.parse(invalid)).toThrow();
  });

  it("rejects malformed versions, UUIDs, revisions, and context", () => {
    for (const invalid of [
      { ...authorizationInput, contractVersion: 2 },
      { ...authorizationInput, requestId: "not-a-uuid" },
      { ...authorizationInput, authorizationRevision: -1 },
      { ...authorizationInput, authorizationRevision: 1.5 },
      { ...authorizationInput, authorizationRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...authorizationInput, principal: { ...authorizationInput.principal, id: "bad" } },
      { ...authorizationInput, entity: { id: "bad" } },
      { ...authorizationInput, resource: { ...authorizationInput.resource, id: "bad" } },
      { ...authorizationInput, context: [] },
      { ...authorizationInput, context: { invalid: undefined } },
    ]) expect(() => authorizationInputSchema.parse(invalid)).toThrow();
  });

  it("enforces stable action and collection bounds", () => {
    const grant = authorizationInput.grants[0];
    const tooManyForbidden = Array.from(
      { length: FORBIDDEN_ACTIONS_MAX_LENGTH + 1 },
      (_, index) => `action.${index}`,
    );
    const tooManyGrants = Array.from({ length: GRANTS_MAX_LENGTH + 1 }, (_, index) => ({
      ...grant,
      id: `grant-${index}`,
    }));
    const tooLargeContext = Object.fromEntries(
      Array.from({ length: CONTEXT_MAX_PROPERTIES + 1 }, (_, index) => [`k${index}`, index]),
    );
    for (const invalid of [
      { ...authorizationInput, action: "" },
      { ...authorizationInput, action: "resource.*" },
      { ...authorizationInput, action: "a".repeat(ACTION_KEY_MAX_LENGTH + 1) },
      { ...authorizationInput, forbiddenActions: ["resource.read", "resource.read"] },
      { ...authorizationInput, forbiddenActions: tooManyForbidden },
      { ...authorizationInput, grants: tooManyGrants },
      { ...authorizationInput, context: tooLargeContext },
      { ...authorizationInput, context: { value: "x".repeat(CONTEXT_MAX_SERIALIZED_LENGTH) } },
    ]) expect(() => authorizationInputSchema.parse(invalid)).toThrow();
  });

  it("rejects duplicate releases, duplicate grants, absent layers, and partial wildcards", () => {
    const grant = authorizationInput.grants[0];
    for (const invalid of [
      { ...authorizationInput, releases: { PLATFORM: id, DOMAIN: id } },
      { ...authorizationInput, grants: [grant, { ...grant, effect: "DENY" }] },
      {
        ...authorizationInput,
        releases: { PLATFORM: id },
        grants: [{ ...grant, layer: "DOMAIN" }],
      },
      { ...authorizationInput, grants: [{ ...grant, action: "resource.*" }] },
      { ...authorizationInput, grants: [{ ...grant, principalId: "aaaa*" }] },
      { ...authorizationInput, grants: [{ ...grant, id: "x".repeat(GRANT_ID_MAX_LENGTH + 1) }] },
    ]) expect(() => authorizationInputSchema.parse(invalid)).toThrow();

    expect(
      authorizationInputSchema.parse({
        ...authorizationInput,
        grants: [{ ...grant, action: "*", principalId: "*", entityId: "*", resourceId: "*" }],
      }),
    ).toBeDefined();
  });

  it("rejects inconsistent, unsorted, duplicate, or unknown decision fields", () => {
    const baseDecision = {
      contractVersion: 1,
      requestId: authorizationInput.requestId,
      authorizationRevision: 17,
      releases: authorizationInput.releases,
      decision: "DENY",
      allow: false,
      reasonCodes: ["EXPLICIT_DENY", "PRINCIPAL_DISABLED"],
      reasonIds: ["grant:a", "platform:principal-disabled"],
      matchedPolicyIds: ["grant:a"],
    } as const;
    for (const invalid of [
      { ...baseDecision, allow: true },
      { ...baseDecision, reasonCodes: [...baseDecision.reasonCodes].reverse() },
      { ...baseDecision, reasonCodes: ["EXPLICIT_DENY", "EXPLICIT_DENY"] },
      { ...baseDecision, reasonIds: [...baseDecision.reasonIds].reverse() },
      { ...baseDecision, matchedPolicyIds: ["grant:a", "grant:a"] },
      { ...baseDecision, releases: { ...baseDecision.releases, OTHER: id } },
      { ...baseDecision, secret: true },
    ]) expect(() => authorizationDecisionSchema.parse(invalid)).toThrow();
  });

  it("accepts only the canonical invalid-input decision envelope", () => {
    const invalidEnvelope = {
      contractVersion: 1,
      requestId: "00000000-0000-0000-0000-000000000000",
      authorizationRevision: 0,
      releases: {},
      decision: "DENY",
      allow: false,
      reasonCodes: ["INVALID_INPUT"],
      reasonIds: [],
      matchedPolicyIds: [],
    } as const;
    expect(authorizationDecisionSchema.parse(invalidEnvelope)).toEqual(invalidEnvelope);
    for (const invalid of [
      { ...invalidEnvelope, requestId: authorizationInput.requestId },
      { ...invalidEnvelope, authorizationRevision: 1 },
      { ...invalidEnvelope, releases: { PLATFORM: id } },
      { ...invalidEnvelope, reasonIds: ["platform:invalid-input"] },
    ]) expect(() => authorizationDecisionSchema.parse(invalid)).toThrow();
  });
});

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

  it("enforces all ProblemDetails boundaries", () => {
    const boundaryProblem = {
      type: "https://innorder.example/problems/boundary",
      title: "T".repeat(PROBLEM_TITLE_MAX_LENGTH),
      status: PROBLEM_STATUS_MAX,
      code: "C".repeat(PROBLEM_CODE_MAX_LENGTH),
      correlationId: id,
      detail: "D".repeat(PROBLEM_DETAIL_MAX_LENGTH),
    };

    expect(problemDetailsSchema.parse(boundaryProblem)).toEqual(boundaryProblem);
    for (const invalid of [
      { ...boundaryProblem, title: "T".repeat(PROBLEM_TITLE_MIN_LENGTH - 1) },
      { ...boundaryProblem, title: "T".repeat(PROBLEM_TITLE_MAX_LENGTH + 1) },
      { ...boundaryProblem, status: PROBLEM_STATUS_MIN - 1 },
      { ...boundaryProblem, status: PROBLEM_STATUS_MAX + 1 },
      { ...boundaryProblem, code: "C".repeat(PROBLEM_CODE_MIN_LENGTH - 1) },
      { ...boundaryProblem, code: "C".repeat(PROBLEM_CODE_MAX_LENGTH + 1) },
      { ...boundaryProblem, detail: "D".repeat(PROBLEM_DETAIL_MAX_LENGTH + 1) },
    ]) {
      expect(() => problemDetailsSchema.parse(invalid)).toThrow();
    }
  });

  it("counts ProblemDetails user-visible text in Unicode code points", () => {
    const problem = {
      type: "https://innorder.example/problems/unicode",
      title: "😀".repeat(PROBLEM_TITLE_MAX_LENGTH),
      status: PROBLEM_STATUS_MIN,
      code: "UNICODE_DETAIL",
      correlationId: id,
      detail: "😀".repeat(PROBLEM_DETAIL_MAX_LENGTH),
    };

    expect(problemDetailsSchema.parse(problem)).toEqual(problem);
  });
});

describe("auth contracts", () => {
  const validPassword = "p".repeat(LOGIN_PASSWORD_MIN_CODE_POINTS);

  it.each([
    "A".repeat(LOGIN_USERNAME_MIN_LENGTH),
    "  Pilot.User  ",
    "user+alias@example.test",
    "A".repeat(LOGIN_USERNAME_MAX_LENGTH),
  ])(
    "accepts printable username input %j without transforming it",
    (username) => {
      expect(loginRequestSchema.parse({ username, password: validPassword })).toEqual({
        username,
        password: validPassword,
      });
    },
  );

  it.each([
    "A".repeat(LOGIN_USERNAME_MIN_LENGTH - 1),
    " ",
    "\t",
    "pilot\nuser",
    "pilot\u0000user",
    "A".repeat(LOGIN_USERNAME_MAX_LENGTH + 1),
  ])(
    "rejects invalid username input %j",
    (username) => {
      expect(() =>
        loginRequestSchema.parse({ username, password: validPassword }),
      ).toThrow();
    },
  );

  it.each([
    "p".repeat(LOGIN_PASSWORD_MIN_CODE_POINTS),
    "😀".repeat(LOGIN_PASSWORD_MIN_CODE_POINTS),
    "😀".repeat(65),
    "p".repeat(LOGIN_PASSWORD_MAX_CODE_POINTS),
  ])(
    "accepts a password containing 12 to 128 Unicode code points",
    (password) => {
      expect(loginRequestSchema.parse({ username: "pilot.user", password })).toEqual({
        username: "pilot.user",
        password,
      });
    },
  );

  it.each([
    "p".repeat(LOGIN_PASSWORD_MIN_CODE_POINTS - 1),
    "😀".repeat(6),
    "p".repeat(LOGIN_PASSWORD_MAX_CODE_POINTS + 1),
  ])(
    "rejects a password outside the Unicode code-point boundaries",
    (password) => {
      expect(() =>
        loginRequestSchema.parse({ username: "pilot.user", password }),
      ).toThrow();
    },
  );

  it("accepts a 43-character base64url refresh token in request and response", () => {
    expect(refreshRequestSchema.parse({ refreshToken })).toEqual({ refreshToken });
    expect(
      tokenResponseSchema.parse({
        tokenType: "Bearer",
        accessToken: "access-token",
        refreshToken,
        expiresIn: 900,
        user: currentUser,
      }),
    ).toMatchObject({ refreshToken });
  });

  it.each([
    "A".repeat(REFRESH_TOKEN_LENGTH - 1),
    "A".repeat(REFRESH_TOKEN_LENGTH + 1),
    `${"A".repeat(REFRESH_TOKEN_LENGTH - 1)}+`,
    `${"A".repeat(REFRESH_TOKEN_LENGTH - 1)}/`,
    `${"A".repeat(REFRESH_TOKEN_LENGTH - 1)}=`,
  ])("rejects invalid refresh token %j", (invalidRefreshToken) => {
    expect(() =>
      refreshRequestSchema.parse({ refreshToken: invalidRefreshToken }),
    ).toThrow();
    expect(() =>
      tokenResponseSchema.parse({
        tokenType: "Bearer",
        accessToken: "access-token",
        refreshToken: invalidRefreshToken,
        expiresIn: 900,
        user: currentUser,
      }),
    ).toThrow();
  });

  it("enforces access-token boundaries", () => {
    expect(
      tokenResponseSchema.parse({
        tokenType: "Bearer",
        accessToken: "A".repeat(ACCESS_TOKEN_MAX_LENGTH),
        refreshToken,
        expiresIn: 900,
        user: currentUser,
      }).accessToken,
    ).toHaveLength(ACCESS_TOKEN_MAX_LENGTH);
    for (const length of [ACCESS_TOKEN_MIN_LENGTH - 1, ACCESS_TOKEN_MAX_LENGTH + 1]) {
      expect(() =>
        tokenResponseSchema.parse({
          tokenType: "Bearer",
          accessToken: "A".repeat(length),
          refreshToken,
          expiresIn: 900,
          user: currentUser,
        }),
      ).toThrow();
    }
  });

  it("enforces expiresIn boundaries", () => {
    const token = {
      tokenType: "Bearer",
      accessToken: "access-token",
      refreshToken,
      user: currentUser,
    } as const;

    expect(
      tokenResponseSchema.parse({ ...token, expiresIn: EXPIRES_IN_MAX_SECONDS }),
    ).toMatchObject({ expiresIn: EXPIRES_IN_MAX_SECONDS });
    for (const expiresIn of [EXPIRES_IN_MIN_SECONDS - 1, EXPIRES_IN_MAX_SECONDS + 1]) {
      expect(() => tokenResponseSchema.parse({ ...token, expiresIn })).toThrow();
    }
  });

  it("enforces CurrentUser string boundaries", () => {
    const boundaryUser = {
      ...currentUser,
      username: "u".repeat(CURRENT_USER_USERNAME_MAX_LENGTH),
      displayName: "D".repeat(CURRENT_USER_DISPLAY_NAME_MAX_LENGTH),
      capabilities: ["C".repeat(CAPABILITY_MAX_LENGTH)],
    };

    expect(currentUserSchema.parse(boundaryUser)).toEqual(boundaryUser);
    for (const invalid of [
      {
        ...boundaryUser,
        username: "u".repeat(CURRENT_USER_USERNAME_MIN_LENGTH - 1),
      },
      {
        ...boundaryUser,
        username: "u".repeat(CURRENT_USER_USERNAME_MAX_LENGTH + 1),
      },
      {
        ...boundaryUser,
        displayName: "D".repeat(CURRENT_USER_DISPLAY_NAME_MIN_LENGTH - 1),
      },
      {
        ...boundaryUser,
        displayName: "D".repeat(CURRENT_USER_DISPLAY_NAME_MAX_LENGTH + 1),
      },
      {
        ...boundaryUser,
        capabilities: ["C".repeat(CAPABILITY_MIN_LENGTH - 1)],
      },
      {
        ...boundaryUser,
        capabilities: ["C".repeat(CAPABILITY_MAX_LENGTH + 1)],
      },
    ]) {
      expect(() => currentUserSchema.parse(invalid)).toThrow();
    }
  });

  it("counts displayName in Unicode code points", () => {
    const user = {
      ...currentUser,
      displayName: "😀".repeat(CURRENT_USER_DISPLAY_NAME_MAX_LENGTH),
    };

    expect(currentUserSchema.parse(user)).toEqual(user);
  });

  it.each([
    [
      loginRequestSchema,
      { username: "pilot.user", password: validPassword, otp: "123456" },
    ],
    [refreshRequestSchema, { refreshToken, accessToken: "secret" }],
    [currentUserSchema, { ...currentUser, passwordHash: "secret" }],
    [
      tokenResponseSchema,
      {
        tokenType: "Bearer",
        accessToken: "access-token",
        refreshToken,
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

  it.each([
    "2026-07-30T12:00:00Z",
    "2026-07-30T12:00:00.123Z",
    "2026-07-30T12:00:00+08:00",
  ])("parses an RFC 3339 instant with seconds: %s", (validOccurredAt) => {
    expect(
      eventEnvelopeSchema.parse({ ...event, occurredAt: validOccurredAt }),
    ).toMatchObject({ occurredAt: validOccurredAt });
  });

  it("rejects an RFC 3339-like timestamp without seconds", () => {
    expect(() =>
      eventEnvelopeSchema.parse({ ...event, occurredAt: "2026-07-30T12:00Z" }),
    ).toThrow();
  });

  it("rejects unknown envelope fields", () => {
    expect(eventEnvelopeSchema).toBeDefined();
    expect(() =>
      eventEnvelopeSchema.parse({ ...event, password: "must-not-leak" }),
    ).toThrow();
  });

  it("enforces event string and version boundaries", () => {
    expect(
      eventEnvelopeSchema.parse({
        ...event,
        type: "T".repeat(EVENT_TYPE_MAX_LENGTH),
        schemaVersion: EVENT_SCHEMA_VERSION_MAX,
        aggregateType: "A".repeat(EVENT_AGGREGATE_TYPE_MAX_LENGTH),
        aggregateVersion: EVENT_AGGREGATE_VERSION_MAX,
      }),
    ).toMatchObject({
      schemaVersion: EVENT_SCHEMA_VERSION_MAX,
      aggregateVersion: EVENT_AGGREGATE_VERSION_MAX,
    });
    for (const invalid of [
      { ...event, type: "T".repeat(EVENT_TYPE_MIN_LENGTH - 1) },
      { ...event, type: "T".repeat(EVENT_TYPE_MAX_LENGTH + 1) },
      { ...event, schemaVersion: EVENT_SCHEMA_VERSION_MIN - 1 },
      { ...event, schemaVersion: EVENT_SCHEMA_VERSION_MAX + 1 },
      {
        ...event,
        aggregateType: "A".repeat(EVENT_AGGREGATE_TYPE_MIN_LENGTH - 1),
      },
      {
        ...event,
        aggregateType: "A".repeat(EVENT_AGGREGATE_TYPE_MAX_LENGTH + 1),
      },
      { ...event, aggregateVersion: EVENT_AGGREGATE_VERSION_MIN - 1 },
      { ...event, aggregateVersion: EVENT_AGGREGATE_VERSION_MAX + 1 },
    ]) {
      expect(() => eventEnvelopeSchema.parse(invalid)).toThrow();
    }
  });
});
