import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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
const invalidPolicyId = "policy:318efe2bf46c41026f67dbd60026ad3a8056a0a70c468cd38210021dee7de176";
const canonicalInvalidDecision = {
  contractVersion: 1,
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

async function evaluateWithOpa(input: JsonObject): Promise<unknown> {
  const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolvePromise, reject) => {
    const child = spawn(process.env.OPA_PATH!, ["eval", "--format=json", "--data", "policies/opa", "--stdin-input", "data.innorder.platform.authz.decision"], { cwd: repositoryRoot, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk)); child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject); child.once("close", (status) => resolvePromise({ status, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    child.stdin.end(JSON.stringify(input));
  });
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

const describeWithOpa = process.env.OPA_PATH ? describe : describe.skip;
const OPA_INTEGRATION_TIMEOUT_MS = 15_000;

describeWithOpa("authorization Zod/OPA parity", () => {
  for (const fixture of fixtures.valid) {
    it(`accepts and evaluates: ${fixture.name}`, async () => {
      const input = materialize(fixture);
      expect(authorizationInputSchema.parse(input)).toEqual(input);
      const decision = await evaluateWithOpa(input);
      expect(() => authorizationDecisionSchema.parse(decision)).not.toThrow();
      expect(decision).toMatchObject({
        opaRevision: input.opaRevision,
        requestId: input.requestId,
        authorizationRevision: input.authorizationRevision,
        releases: input.releases,
      });
    }, OPA_INTEGRATION_TIMEOUT_MS);
  }

  for (const fixture of fixtures.invalid) {
    it(`fails closed identically: ${fixture.name}`, async () => {
      const input = materialize(fixture);
      expect(() => authorizationInputSchema.parse(input)).toThrow();
      expect(await evaluateWithOpa(input)).toEqual(canonicalInvalidDecision);
    }, OPA_INTEGRATION_TIMEOUT_MS);
  }

  it("fails closed when the expected OPA runtime revision differs", async () => {
    const input = { ...fixtures.baseInput, opaRevision: "platform-authz-v2" };
    expect(authorizationInputSchema.parse(input)).toEqual(input);
    expect(await evaluateWithOpa(input)).toEqual(canonicalInvalidDecision);
  }, OPA_INTEGRATION_TIMEOUT_MS);
});
