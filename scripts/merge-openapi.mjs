#!/usr/bin/env node
// Structural three-way merge for the Core OpenAPI document. Textual merging
// splices unrelated path bodies together, so the merge happens on the parsed
// document instead: sections are combined key by key against the merge base.
import { readFileSync, writeFileSync } from "node:fs";

import YAML from "yaml";

const [basePath, headPath, otherPath, outPath] = process.argv.slice(2);
if (!basePath || !headPath || !otherPath || !outPath) {
  console.error("usage: merge-openapi.mjs <base> <head> <other> <out>");
  process.exit(2);
}

function load(path) {
  const doc = YAML.parseDocument(readFileSync(path, "utf8"), { merge: true });
  if (doc.errors.length > 0) {
    throw new Error(`${path}: ${doc.errors[0].message}`);
  }
  return doc.toJS();
}

const base = load(basePath);
const head = load(headPath);
const other = load(otherPath);

// Reviewed add/add differences where head is equivalent or stricter:
// the two response descriptions only reword the same contract, and head's
// Idempotency-Key adds a printable-ASCII pattern the other side omits.
const PREFER_HEAD = new Set([
  "components.responses.NotFound",
  "components.responses.Conflict",
  "components.parameters.IdempotencyKey",
]);

const conflicts = [];

function mergeMap(section, baseMap = {}, headMap = {}, otherMap = {}) {
  const merged = { ...headMap };
  for (const [key, otherValue] of Object.entries(otherMap)) {
    const inHead = Object.prototype.hasOwnProperty.call(headMap, key);
    if (!inHead) {
      merged[key] = otherValue;
      continue;
    }
    const headJson = JSON.stringify(headMap[key]);
    const otherJson = JSON.stringify(otherValue);
    if (headJson === otherJson) continue;
    const baseJson = Object.prototype.hasOwnProperty.call(baseMap, key)
      ? JSON.stringify(baseMap[key])
      : undefined;
    if (baseJson === headJson) {
      // Only the other side changed it.
      merged[key] = otherValue;
    } else if (baseJson === otherJson || PREFER_HEAD.has(`${section}.${key}`)) {
      // Keep head: either only head changed it, or head is the reviewed winner.
    } else {
      conflicts.push(`${section}.${key}`);
    }
  }
  return merged;
}

const result = { ...head };
result.paths = mergeMap("paths", base.paths, head.paths, other.paths);

const componentSections = new Set([
  ...Object.keys(base.components ?? {}),
  ...Object.keys(head.components ?? {}),
  ...Object.keys(other.components ?? {}),
]);
result.components = {};
for (const section of componentSections) {
  result.components[section] = mergeMap(
    `components.${section}`,
    base.components?.[section],
    head.components?.[section],
    other.components?.[section],
  );
}

// Top-level extension anchors are plain keys once aliases are resolved.
for (const [key, value] of Object.entries(other)) {
  if (key === "paths" || key === "components") continue;
  if (!Object.prototype.hasOwnProperty.call(result, key)) result[key] = value;
}

if (conflicts.length > 0) {
  console.error("conflicting definitions on both sides:");
  for (const entry of conflicts) console.error(`  ${entry}`);
  process.exit(1);
}

writeFileSync(outPath, YAML.stringify(result, { lineWidth: 0 }));
console.log(
  `merged: paths=${Object.keys(result.paths).length} ` +
    Object.entries(result.components)
      .map(([name, map]) => `${name}=${Object.keys(map).length}`)
      .join(" "),
);
