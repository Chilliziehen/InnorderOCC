import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { findNonRegistryArtifacts } from "./dependency-provenance.mjs";

test("package lock resolves remote artifacts only from the official npm registry", async () => {
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.deepEqual(findNonRegistryArtifacts(lock), []);
});

test("Gradle plugin resolution prefers Maven Central and falls back to the Plugin Portal", async () => {
  const settings = await readFile(new URL("../settings.gradle.kts", import.meta.url), "utf8");
  const pluginRepositories = settings.slice(settings.indexOf("pluginManagement"), settings.indexOf("plugins {"));
  const repositoryBlock = pluginRepositories.match(/repositories\s*\{([^}]*)\}/u);
  assert.ok(repositoryBlock, "pluginManagement must declare repositories");
  assert.deepEqual(repositoryBlock[1].trim().split(/\r?\n/u).map((line) => line.trim()), [
    "mavenCentral()",
    "gradlePluginPortal()",
  ]);
});

test("rejects every non-registry remote resolved form", () => {
  const resolvedValues = [
    "git+https://github.com/example/project.git",
    "git+ssh://git@github.com/example/project.git",
    "ssh://git@github.com/example/project.git",
    "github:example/project",
    "example/project",
    "https://github.com/example/project/archive/refs/tags/v1.0.0.tar.gz",
    "file:///tmp/project.tgz",
    "http://registry.npmjs.org/project/-/project-1.0.0.tgz",
    "https://registry.npmjs.org.evil.invalid/project.tgz",
    "https://user@registry.npmjs.org/project/-/project-1.0.0.tgz",
    "https://registry.npmjs.org:443/project/-/project-1.0.0.tgz",
    "https://registry.npmjs.org/project/-/project-1.0.0.tgz?source=other",
  ];

  for (const resolved of resolvedValues) {
    const lock = { packages: { "": {}, "node_modules/project": { version: "1.0.0", resolved } } };
    assert.deepEqual(findNonRegistryArtifacts(lock), [`node_modules/project: ${resolved}`]);
  }
});

test("allows exact registry tarballs and recognized local npm workspace links", () => {
  const registry = "https://registry.npmjs.org/project/-/project-1.0.0.tgz";
  const lock = {
    packages: {
      "": { workspaces: ["packages/*"] },
      "packages/contracts": { name: "@example/contracts", version: "1.0.0" },
      "node_modules/@example/contracts": { resolved: "packages/contracts", link: true },
      "node_modules/project": { version: "1.0.0", resolved: registry },
    },
  };

  assert.deepEqual(findNonRegistryArtifacts(lock), []);
});

test("rejects remote or unrecognized entries disguised as workspace links", () => {
  const fixtures = [
    { resolved: "https://registry.npmjs.org/project/-/project-1.0.0.tgz", link: true },
    { resolved: "../outside", link: true },
    { resolved: "packages/missing", link: true },
    { resolved: "packages/contracts", link: false },
  ];

  for (const entry of fixtures) {
    const lock = {
      packages: {
        "": { workspaces: ["packages/*"] },
        "packages/contracts": { name: "@example/contracts", version: "1.0.0" },
        "node_modules/project": entry,
      },
    };
    assert.equal(findNonRegistryArtifacts(lock).length, 1);
  }
});

test("rejects dependency records with remote versions and no resolved field", () => {
  for (const version of ["git+https://github.com/example/project.git", "github:example/project", "file:///tmp/project.tgz"]) {
    const lock = { packages: { "": {}, "node_modules/project": { version } } };
    assert.deepEqual(findNonRegistryArtifacts(lock), [`node_modules/project: ${version}`]);
  }
});
