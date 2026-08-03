#!/usr/bin/env node
// Keep the OpenAPI problem-code enums generated from the Zod contract so the
// published spec cannot drift from the schemas the services actually validate.
import { readFileSync, writeFileSync } from "node:fs";

import YAML from "yaml";

const SOURCE = "packages/contracts/src/problem-details.ts";
const SPEC = "packages/contracts/openapi/occ-core.yaml";
// baseProblemCodeSchema excludes the codes that only their own strict variants
// may carry; the spec's BaseProblemCode must exclude exactly the same ones.
const BASE_EXCLUDED = ["OCC_STALE_VERSION", "OCC_PARTICIPANT_PROCESS_EXISTS"];

const source = readFileSync(SOURCE, "utf8");

function codeList(name) {
  const pattern = new RegExp(
    String.raw`export const ${name} = \[([\s\S]*?)\] as const;`,
  );
  const match = source.match(pattern);
  if (!match) throw new Error(`${name} not found in ${SOURCE}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

const platform = codeList("PLATFORM_PROBLEM_CODES");
const workflow = codeList("WORKFLOW_ERROR_CODES");
const all = [...platform, ...workflow];

const document = YAML.parse(readFileSync(SPEC, "utf8"));
const { schemas } = document.components;
schemas.OccProblemCode.enum = platform;
schemas.ProblemCode.enum = all;
schemas.BaseProblemCode.enum = all.filter((code) => !BASE_EXCLUDED.includes(code));
writeFileSync(SPEC, YAML.stringify(document, { lineWidth: 0 }));

console.log(
  `OccProblemCode=${platform.length} ProblemCode=${all.length} ` +
    `BaseProblemCode=${schemas.BaseProblemCode.enum.length}`,
);
