import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { authorizationDecisionSchema, authorizationInputSchema } from "../src/index.js";

type JsonObject = Record<string, unknown>;
type FixtureCase = {
  name: string;
  overrides: JsonObject;
  grantIdRepeat?: { value: string; count: number };
  contextRepeat?: { value: string; count: number; target: "key" | "value" };
  malformedOptionalRelease?: { layer: "DOMAIN" | "CUSTOMER"; value: unknown };
};
type Fixtures = { baseInput: JsonObject; valid: FixtureCase[]; invalid: FixtureCase[] };

const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/authorization-parity.json", import.meta.url), "utf8"),
) as Fixtures;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dockerContainer = `innorder-authz-parity-${process.pid}`;
const invalidPolicyId = "policy:318efe2bf46c41026f67dbd60026ad3a8056a0a70c468cd38210021dee7de176";
const canonicalInvalidDecision = {
  contractVersion: 2,
  opaRevision: "",
  requestId: "00000000-0000-0000-0000-000000000000",
  authorizationRevision: 0,
  releases: {},
  decision: "DENY",
  allow: false,
  reasonCodes: ["INVALID_INPUT"],
  reasonIds: [invalidPolicyId],
  matchedPolicyIds: [],
};

function evaluateWithOpa(input: JsonObject): unknown {
  const executable = process.env.OPA_PATH ?? "docker";
  const opaArguments = [
    "eval", "--format=json", "--data", "policies/opa", "--stdin-input",
    "data.innorder.platform.authz.decision",
  ];
  const args = process.env.OPA_PATH
    ? opaArguments
    : ["exec", "-i", dockerContainer, "/opa", ...opaArguments];
  const result = spawnSync(
    executable,
    args,
    { cwd: repositoryRoot, encoding: "utf8", input: JSON.stringify(input) },
  );
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const output = JSON.parse(result.stdout) as {
    result: Array<{ expressions: Array<{ value: unknown }> }>;
  };
  return output.result[0]?.expressions[0]?.value;
}

function materialize(fixture: FixtureCase): JsonObject {
  const input = { ...fixtures.baseInput, ...fixture.overrides };
  if (fixture.grantIdRepeat) {
    const grants = input.grants as JsonObject[];
    input.grants = [
      { ...grants[0], id: fixture.grantIdRepeat.value.repeat(fixture.grantIdRepeat.count) },
      ...grants.slice(1),
    ];
  }
  if (fixture.contextRepeat) {
    const repeated = fixture.contextRepeat.value.repeat(fixture.contextRepeat.count);
    input.context = fixture.contextRepeat.target === "key"
      ? { [repeated]: "value" }
      : { value: repeated };
  }
  if (fixture.malformedOptionalRelease) {
    input.releases = {
      ...(input.releases as JsonObject),
      [fixture.malformedOptionalRelease.layer]: fixture.malformedOptionalRelease.value,
    };
    input.grants = [{
      id: "matching-platform-allow",
      layer: "PLATFORM",
      releaseId: "550e8400-e29b-41d4-a716-446655440000",
      effect: "ALLOW",
      action: "resource.read",
      principalId: "*",
      entityId: "*",
      resourceId: "*",
    }];
  }
  return input;
}

const describeWithOpa = process.env.OPA_PATH || process.env.OPA_DOCKER_IMAGE ? describe : describe.skip;

describeWithOpa("authorization Zod/OPA parity", () => {
  beforeAll(() => {
    if (process.env.OPA_PATH) return;
    const result = spawnSync("docker", [
      "run", "--rm", "-d", "--name", dockerContainer,
      "-v", `${repositoryRoot}:/workspace`, "-w", "/workspace",
      process.env.OPA_DOCKER_IMAGE!, "run", "--server", "policies/opa",
    ], { cwd: repositoryRoot, encoding: "utf8" });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  afterAll(() => {
    if (!process.env.OPA_PATH) spawnSync("docker", ["rm", "-f", dockerContainer]);
  });

  for (const fixture of fixtures.valid) {
    it(`accepts and evaluates: ${fixture.name}`, () => {
      const input = materialize(fixture);
      expect(authorizationInputSchema.parse(input)).toEqual(input);
      const decision = evaluateWithOpa(input);
      expect(() => authorizationDecisionSchema.parse(decision)).not.toThrow();
      expect(decision).toMatchObject({
        opaRevision: input.opaRevision,
        requestId: input.requestId,
        authorizationRevision: input.authorizationRevision,
        releases: input.releases,
      });
    });
  }

  for (const fixture of fixtures.invalid) {
    it(`fails closed identically: ${fixture.name}`, () => {
      const input = materialize(fixture);
      expect(() => authorizationInputSchema.parse(input)).toThrow();
      expect(evaluateWithOpa(input)).toEqual(canonicalInvalidDecision);
    });
  }

  it("fails closed when the expected OPA runtime revision differs", () => {
    const input = { ...fixtures.baseInput, opaRevision: "platform-authz-v1" };
    expect(authorizationInputSchema.parse(input)).toEqual(input);
    expect(evaluateWithOpa(input)).toEqual(canonicalInvalidDecision);
  });
});
