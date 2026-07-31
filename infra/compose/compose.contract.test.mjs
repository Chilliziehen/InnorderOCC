import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { DockerfileParser } from "dockerfile-ast";
import { parse } from "yaml";

const read = (path) => readFileSync(path, "utf8");
const composePath = "infra/compose/compose.yml";

test("root verification includes workspace, infrastructure, and database contracts without recursion", () => {
  const rootPackage = JSON.parse(read("package.json"));
  const rootReadme = read("README.md");
  const foundationDesign = read("Docs/superpowers/specs/2026-07-28-software-foundation-design.md");

  assert.equal(rootPackage.scripts.test, "node scripts/verify.mjs --tests");
  assert.equal(rootPackage.scripts.verify, "node scripts/verify.mjs");
  assert.equal(rootPackage.scripts["verify:local"], "node scripts/verify.mjs --local");
  assert.equal(rootPackage.scripts["verify:full"], "node scripts/verify.mjs --full");
  assert.equal(rootPackage.scripts["test:verify"], "node --test scripts/verify.test.mjs");
  assert.match(rootPackage.scripts["test:workspaces"], /--workspaces --if-present/u);
  assert.match(rootPackage.scripts["test:infra"], /compose\.contract\.test\.mjs/u);
  assert.match(rootPackage.scripts["test:database"], /schema-static\.test\.mjs/u);
  assert.doesNotMatch(rootPackage.scripts["test:workspaces"], /npm test\b/u);
  assert.equal(rootPackage.devDependencies["@electric-sql/pglite"], "0.5.4");
  const desktopPackage = JSON.parse(read("apps/desktop/package.json"));
  assert.equal(desktopPackage.scripts.dev, "node scripts/run-forge.mjs start");
  assert.ok(existsSync("scripts/verify.mjs"), "root verification orchestrator must exist");
  assert.match(rootReadme, /npm test[\s\S]*Core Kotlin tests/u);
  assert.match(rootReadme, /npm run verify:local[\s\S]*local verification/u);
  assert.match(rootReadme, /npm run verify:full[\s\S]*Docker[\s\S]*OPA[\s\S]*skipped/u);
  assert.match(foundationDesign, /Quick and local verification do not require Docker or OPA/u);
  assert.match(foundationDesign, /Strict full verification requires a responding Docker engine and an actual OPA executable/u);
  assert.match(foundationDesign, /Completion Criteria[\s\S]*strict full verification[\s\S]*no skipped Docker integration tests/u);
  assert.doesNotMatch(foundationDesign, /Docker execution is not required by the verifier/u);

  const dryRun = spawnSync(process.execPath, ["scripts/verify.mjs", "--full", "--dry-run"], {
    encoding: "utf8",
  });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  for (const expected of [
    "test:workspaces",
    "test:verify",
    "test:infra",
    "test:database",
    "test:electron-provenance",
    ":services:core:build",
    ":services:core:test",
    "typecheck --workspaces",
    "build --workspace @innorder/contracts",
    "build --workspace @innorder/ai-service",
    "build --workspace @innorder/desktop",
    "database/tests/pglite-smoke.mjs",
    "smoke --workspace @innorder/desktop",
  ]) {
    assert.match(dryRun.stdout, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  }
});

test("local and Compose AI runtimes use port 3100", () => {
  const aiConfig = read("services/ai/src/config.ts");
  const desktopMain = read("apps/desktop/src/main.ts");
  const coreConfig = read("services/core/src/main/resources/application.yml");
  const aiDockerfile = read("services/ai/Dockerfile");
  const compose = parse(read(composePath));

  assert.match(aiConfig, /\.default\(3100\)/u);
  assert.match(desktopMain, /AI_BASE_URL[^\n]+127\.0\.0\.1:3100/u);
  assert.match(coreConfig, /AI_BASE_URL:http:\/\/localhost:3100/u);
  assert.match(aiDockerfile, /EXPOSE 3100/u);
  assert.match(aiDockerfile, /localhost:3100\/health/u);
  assert.equal(compose.services.ai.environment.PORT, 3100);
  assert.equal(compose.services.ai.ports, undefined);
  assert.ok(compose.services["host-gateway"].ports.includes("127.0.0.1:${AI_PORT:-3100}:3100"));
  assert.ok(compose.services.ai.healthcheck.test.join(" ").includes("localhost:3100/health"));
  assert.equal(compose.services.core.environment.AI_BASE_URL, "http://ai:3100");
});

const expectedImages = {
  kafka: "apache/kafka:3.9.1@sha256:4ceccc577f03f51f6af8dbfda55194d0d892f4fa7913ffbded567ce3895622ed",
  minio: "minio/minio:RELEASE.2025-04-22T22-12-26Z@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e",
  "minio-init": "minio/mc:RELEASE.2025-04-16T18-13-26Z@sha256:aead63c77f9db9107f1696fb08ecb0faeda23729cde94b0f663edf4fe09728e3",
  "minio-volume-init": "alpine:3.21.3@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c",
  postgres: "pgvector/pgvector:0.8.0-pg16@sha256:a132765ec351c65111b5b675928a3a0515a466a40f97277329db8b8209ad8bc9",
  redis: "redis:7.4.2-alpine3.21@sha256:02419de7eddf55aa5bcf49efb74e88fa8d931b4d77c07eff8a6b2144472b6952",
};

function parseDockerfile(path) {
  const ast = DockerfileParser.parse(read(path));
  assert.ok(ast.getInstructions().length > 0, `${path} must parse into instructions`);
  return ast;
}

function assertCoreBootJarUsesGradleCache(ast) {
  const bootJarRuns = ast.getInstructions().filter((instruction) =>
    instruction.getKeyword() === "RUN" && instruction.getArgumentsContent()?.includes(":services:core:bootJar"));
  assert.equal(bootJarRuns.length, 1, "core Dockerfile must have exactly one bootJar RUN");
  assert.deepEqual(bootJarRuns[0].getFlags().map((flag) => [flag.getName(), flag.getValue()]), [
    ["mount", "type=cache,target=/root/.gradle,sharing=locked"],
  ], "core bootJar RUN must use the locked Gradle cache mount");
  assert.match(bootJarRuns[0].getArgumentsContent(),
    /^chmod \+x gradlew\s+&& \.\/gradlew :services:core:bootJar --no-daemon\b/u,
    "core bootJar RUN must chmod and invoke Gradle in the mounted instruction");
}

function assertPinnedFroms(ast, path) {
  for (const from of ast.getFROMs()) {
    assert.ok(from.getImageTag(), `${path} FROM must retain a readable tag`);
    assert.match(from.getImageDigest() ?? "", /^sha256:[a-f0-9]{64}$/u, `${path} FROM must pin a digest`);
  }
}

function secretTargets(service) {
  return Object.fromEntries((service.secrets ?? []).map((secret) => [secret.source, secret.target]));
}

test("structurally checks OPA policy fail-closed and opaque-reference constructs", () => {
  const policy = read("policies/opa/platform/authz.rego");
  const tests = read("policies/opa/platform/authz_test.rego");
  const documentation = read("policies/opa/README.md");

  assert.match(policy, /^package innorder\.platform\.authz/m);
  assert.match(policy, /^import rego\.v1$/m);
  assert.match(policy, /default decision :=/);
  assert.match(policy, /"requestId": "00000000-0000-0000-0000-000000000000"/u);
  assert.match(policy, /object\.keys\(input\) ==/u);
  assert.match(policy, /every grant in grants\s*\{\s*valid_grant\(grant, releases\)/u);
  assert.match(policy, /grant\.layer in object\.keys\(releases\)/u);
  assert.match(policy, /count\(denial_reason_codes\) == 0/u);
  assert.match(policy, /crypto\.sha256\(grant\.id\)/u);
  assert.match(policy, /"reasonCodes": sort\(reason_codes\)/u);
  assert.match(policy, /"matchedPolicyIds": sort\(matched_policy_ids\)/u);
  assert.match(policy, /data\.innorder\.platform\.authz\.decision|package innorder\.platform\.authz/u);
  for (const token of [
    "contractVersion",
    "authorizationRevision",
    "PLATFORM",
    "DOMAIN",
    "CUSTOMER",
    "PRINCIPAL_DISABLED",
    "RESOURCE_INACTIVE",
    "ACTION_FORBIDDEN",
    "EXPLICIT_DENY",
    "NO_MATCHING_ALLOW",
    "INVALID_INPUT",
    "reasonCodes",
    "reasonIds",
    "matchedPolicyIds",
  ]) {
    assert.ok(policy.includes(token), `policy must include ${token}`);
  }

  for (const testName of [
    "test_all_layers_can_allow",
    "test_allow_and_abstain_allows",
    "test_all_abstain_denies",
    "test_absent_optional_layers_are_not_applicable",
    "test_grant_for_absent_layer_invalidates_request",
    "test_each_layer_explicit_deny_overrides_allows",
    "test_baseline_denials_are_non_overridable",
    "test_exact_wildcard_matches_all_dimensions",
    "test_partial_wildcard_is_invalid",
    "test_unknown_and_malformed_fields_deny_deterministically",
    "test_duplicate_release_and_grant_ids_deny",
    "test_oversized_values_deny",
    "test_reason_and_policy_ids_are_sorted_distinct_and_opaque",
  ]) {
    assert.match(tests, new RegExp(`\\b${testName}\\b`));
  }
  assert.match(tests, /SENSITIVE_CONTEXT_TOKEN/u);
  assert.match(tests, /SENSITIVE_GRANT_ID_Z/u);
  assert.match(tests, /json\.marshal\(result\)/u);
  assert.match(documentation, /data\.innorder\.platform\.authz\.decision/u);
  assert.match(documentation, /"contractVersion": 1/u);
  assert.match(documentation, /"releaseId":/u);
  assert.match(documentation, /DOMAIN.*CUSTOMER.*optional/is);
  assert.match(documentation, /Core.*active.*grants/is);
  assert.doesNotMatch(documentation, /reason_codes|reason_ids|forbidden_actions|principal_id|entity_id|resource_id/u);
});

test("Compose defines digest-pinned, healthy services on an internal network", () => {
  const compose = parse(read(composePath));
  assert.equal(compose.version, undefined);
  assert.deepEqual(Object.keys(compose.services).sort(), [
    "ai",
    "core",
    "host-gateway",
    "kafka",
    "minio",
    "minio-init",
    "minio-volume-init",
    "opa",
    "postgres",
    "redis",
  ]);
  assert.equal(compose.networks.backend.internal, true);
  assert.equal(compose.networks["host-access"].internal, undefined);

  for (const [name, service] of Object.entries(compose.services)) {
    if (!["minio-init", "minio-volume-init"].includes(name)) {
      assert.ok(service.healthcheck?.test, `${name} must have a healthcheck`);
    }
    if (name === "host-gateway") {
      assert.deepEqual(service.networks, ["backend", "host-access"]);
    } else {
      assert.deepEqual(service.networks, ["backend"], `${name} must remain backend-only`);
      assert.equal(service.ports, undefined, `${name} must not publish ports directly`);
    }
    if (service.image) {
      assert.match(service.image, /:[^@\s]+@sha256:[a-f0-9]{64}$/u, `${name} image must pin tag and digest`);
      assert.equal(service.image, expectedImages[name], `${name} image digest must be registry-verified`);
    }
    for (const port of service.ports ?? []) {
      assert.match(String(port), /^127\.0\.0\.1:/u, `${name} port must be loopback-bound`);
    }
  }

  const gateway = compose.services["host-gateway"];
  assert.ok(gateway.build);
  assert.deepEqual(gateway.ports, [
    "127.0.0.1:${POSTGRES_PORT:-5432}:5432",
    "127.0.0.1:${KAFKA_PORT:-9092}:9092",
    "127.0.0.1:${REDIS_PORT:-6379}:6379",
    "127.0.0.1:${MINIO_API_PORT:-9000}:9000",
    "127.0.0.1:${MINIO_CONSOLE_PORT:-9001}:9001",
    "127.0.0.1:${OPA_PORT:-8181}:8181",
    "127.0.0.1:${AI_PORT:-3100}:3100",
    "127.0.0.1:${CORE_PORT:-8080}:8080",
  ]);
  assert.equal(gateway.read_only, true);
  assert.deepEqual(gateway.cap_drop, ["ALL"]);
  assert.deepEqual(gateway.security_opt, ["no-new-privileges:true"]);
  assert.equal(gateway.user, "node");
  assert.deepEqual(gateway.secrets ?? [], []);
  assert.equal(gateway.depends_on, undefined, "gateway routes must start independently of backend health");

  assert.equal(compose.services.opa.image, undefined);
  assert.ok(compose.services.core.build);
  assert.ok(compose.services.ai.build);

  assert.deepEqual(Object.keys(compose.volumes).sort(), [
    "kafka-data",
    "minio-data",
    "postgres-data",
    "redis-data",
  ]);
});

test("Compose wiring follows application config and completion gates", () => {
  const compose = parse(read(composePath));
  const core = compose.services.core;
  const ai = compose.services.ai;
  assert.ok(compose.services.postgres.healthcheck.test.join(" ").includes("-h 127.0.0.1"));
  assert.match(compose.services.kafka.healthcheck.test.join(" "), /--bootstrap-server localhost:29092\b/u);

  assert.deepEqual(Object.keys(core.environment).sort(), [
    "AI_BASE_URL",
    "APP_VERSION",
    "DATABASE_JDBC_URL",
    "DATABASE_USERNAME",
    "FLYWAY_USERNAME",
    "KAFKA_BOOTSTRAP_SERVERS",
    "OBJECT_STORAGE_BUCKET",
    "OBJECT_STORAGE_ENDPOINT",
    "OPA_BASE_URL",
    "REDIS_HOST",
    "REDIS_PORT",
    "SERVER_PORT",
    "SPRING_CONFIG_IMPORT",
    "SPRING_KAFKA_PRODUCER_ACKS",
    "SPRING_KAFKA_PRODUCER_PROPERTIES_DELIVERY_TIMEOUT_MS",
    "SPRING_KAFKA_PRODUCER_PROPERTIES_ENABLE_IDEMPOTENCE",
    "SPRING_KAFKA_PRODUCER_PROPERTIES_REQUEST_TIMEOUT_MS",
    "SPRING_KAFKA_PRODUCER_RETRIES",
  ]);
  assert.deepEqual(Object.keys(ai.environment).sort(), [
    "HOST",
    "LOG_LEVEL",
    "NODE_ENV",
    "PORT",
    "npm_package_version",
  ]);
  assert.equal(core.environment.APP_VERSION, "${APP_VERSION:-0.1.0}");
  assert.equal(ai.environment.npm_package_version, "${APP_VERSION:-0.1.0}");
  assert.deepEqual(core.depends_on, {
    postgres: { condition: "service_healthy" },
  });
  assert.ok(core.healthcheck.test.includes("http://localhost:8080/actuator/health/readiness"));

  const opa = compose.services.opa;
  assert.equal(opa.build.dockerfile, "infra/compose/opa.Dockerfile");
  assert.ok(opa.volumes.some((mount) => String(mount).endsWith(":/policies:ro")));
  assert.ok(opa.command.includes("--log-level=error"));
  assert.deepEqual(opa.healthcheck.test.slice(0, 2), ["CMD", "wget"]);
  assert.ok(opa.healthcheck.test.includes("http://localhost:8181/health"));

  const opaIgnore = read("infra/compose/opa.Dockerfile.dockerignore");
  const opaEntrypoint = read("infra/compose/opa-entrypoint.sh");
  assert.match(opaIgnore, /^\*\*$/mu);
  assert.match(opaIgnore, /^!infra\/compose\/opa-entrypoint\.sh$/mu);
  assert.match(opaEntrypoint, /opa check --strict \/policies/u);
  assert.match(opaEntrypoint, /exec opa "\$@"/u);
});

test("Compose enforces least-privilege file-backed secret boundaries", () => {
  const compose = parse(read(composePath));
  const secretNames = [
    "minio_app_password",
    "minio_app_user",
    "minio_root_password",
    "minio_root_user",
    "postgres_admin_password",
    "postgres_flyway_password",
    "postgres_runtime_password",
    "redis_password",
  ];
  assert.deepEqual(Object.keys(compose.secrets).sort(), secretNames);
  for (const secret of secretNames) {
    assert.match(compose.secrets[secret].file, /^\$\{[A-Z0-9_]+_FILE:\?[^}]+\}$/u);
  }

  assert.deepEqual(secretTargets(compose.services.core), {
    minio_app_password: "occ.object-storage.secret-key",
    minio_app_user: "occ.object-storage.access-key",
    postgres_flyway_password: "spring.flyway.password",
    postgres_runtime_password: "spring.datasource.password",
    redis_password: "spring.data.redis.password",
  });
  assert.deepEqual(secretTargets(compose.services.postgres), {
    postgres_admin_password: "postgres_admin_password",
    postgres_flyway_password: "postgres_flyway_password",
    postgres_runtime_password: "postgres_runtime_password",
  });
  assert.deepEqual(secretTargets(compose.services.minio), {
    minio_root_password: "minio_root_password",
    minio_root_user: "minio_root_user",
  });
  assert.deepEqual(secretTargets(compose.services["minio-init"]), {
    minio_app_password: "minio_app_password",
    minio_app_user: "minio_app_user",
    minio_root_password: "minio_root_password",
    minio_root_user: "minio_root_user",
  });
  assert.deepEqual(secretTargets(compose.services.redis), {
    redis_password: "redis_password",
  });

  const consumers = Object.fromEntries(secretNames.map((secret) => [secret, []]));
  for (const [serviceName, service] of Object.entries(compose.services)) {
    for (const secret of service.secrets ?? []) consumers[secret.source].push(serviceName);
  }
  for (const names of Object.values(consumers)) names.sort();
  assert.deepEqual(consumers, {
    minio_app_password: ["core", "minio-init"],
    minio_app_user: ["core", "minio-init"],
    minio_root_password: ["minio", "minio-init"],
    minio_root_user: ["minio", "minio-init"],
    postgres_admin_password: ["postgres"],
    postgres_flyway_password: ["core", "postgres"],
    postgres_runtime_password: ["core", "postgres"],
    redis_password: ["core", "redis"],
  });

  assert.equal(compose.services.postgres.environment.POSTGRES_PASSWORD_FILE, "/run/secrets/postgres_admin_password");
  assert.equal(compose.services.minio.environment.MINIO_ROOT_USER_FILE, "/run/secrets/minio_root_user");
  assert.equal(compose.services.minio.environment.MINIO_ROOT_PASSWORD_FILE, "/run/secrets/minio_root_password");
  assert.equal(compose.services.core.environment.SPRING_CONFIG_IMPORT, "configtree:/run/secrets/");
  assert.equal(compose.services.core.environment.DATABASE_USERNAME, "innorder_runtime");
  assert.equal(compose.services.core.environment.FLYWAY_USERNAME, "innorder_flyway");
  assert.equal(compose.services.core.environment.SPRING_KAFKA_PRODUCER_RETRIES, 0);
  assert.equal(compose.services.core.environment.SPRING_KAFKA_PRODUCER_ACKS, "all");
  assert.equal(compose.services.core.environment.SPRING_KAFKA_PRODUCER_PROPERTIES_ENABLE_IDEMPOTENCE, false);
  assert.equal(compose.services.core.environment.SPRING_KAFKA_PRODUCER_PROPERTIES_DELIVERY_TIMEOUT_MS, 4000);
  assert.equal(compose.services.core.environment.SPRING_KAFKA_PRODUCER_PROPERTIES_REQUEST_TIMEOUT_MS, 3000);
  assert.equal(compose.services.minio.user, "10001:10001");
  assert.ok(compose.services.minio.healthcheck.test.includes("http://localhost:9000/minio/health/ready"));
  assert.equal(compose.services.minio.depends_on["minio-volume-init"].condition, "service_completed_successfully");
  assert.ok(compose.services.postgres.volumes.includes("./postgres/010-create-roles.sh:/docker-entrypoint-initdb.d/010-create-roles.sh:ro"));
  assert.ok(compose.services["minio-init"].volumes.includes("./minio/init.sh:/config/init.sh:ro"));

  const postgresInit = read("infra/compose/postgres/010-create-roles.sh");
  assert.match(postgresInit, /--set=flyway_password=/u);
  assert.match(postgresInit, /--set=runtime_password=/u);
  assert.match(postgresInit, /:'flyway_password'/u);
  assert.match(postgresInit, /:'runtime_password'/u);
  assert.doesNotMatch(postgresInit, /PASSWORD\s+['"]?\$\{/u);
  const minioInit = read("infra/compose/minio/init.sh");
  assert.match(minioInit, /value="\$\(cat "\$path"\)"/u);
  assert.match(minioInit, /read_secret \/run\/secrets\/minio_root_user/u);
  assert.match(minioInit, /read_secret \/run\/secrets\/minio_app_password/u);
  assert.match(minioInit, /root_user" = "\$app_user/u);
  assert.match(minioInit, /root_password" = "\$app_password/u);
  assert.match(minioInit, /mc admin policy attach/u);

  const example = read("infra/compose/.env.example");
  const expectedSecretPaths = [
    "MINIO_APP_PASSWORD_FILE",
    "MINIO_APP_USER_FILE",
    "MINIO_ROOT_PASSWORD_FILE",
    "MINIO_ROOT_USER_FILE",
    "POSTGRES_ADMIN_PASSWORD_FILE",
    "POSTGRES_FLYWAY_PASSWORD_FILE",
    "POSTGRES_RUNTIME_PASSWORD_FILE",
    "REDIS_PASSWORD_FILE",
  ];
  for (const line of example.split(/\r?\n/u)) {
    if (!line || line.startsWith("#")) continue;
    assert.match(line, /^[A-Z][A-Z0-9_]*=$/u, `environment value must be blank: ${line}`);
  }
  for (const name of expectedSecretPaths) assert.match(example, new RegExp(`^${name}=$`, "mu"));
  assert.doesNotMatch(example, /^(?:POSTGRES_PASSWORD|REDIS_PASSWORD|MINIO_ROOT_USER|MINIO_ROOT_PASSWORD)=$/mu);
  assert.doesNotMatch(example, /changeme|example123|replace[-_ ]me|dummy/iu);
});

test("Dockerfile AST enforces pinned stages, lifecycle ordering, users, and entrypoints", () => {
  const ai = parseDockerfile("services/ai/Dockerfile");
  const core = parseDockerfile("services/core/Dockerfile");
  const gateway = parseDockerfile("infra/compose/gateway.Dockerfile");
  const opa = parseDockerfile("infra/compose/opa.Dockerfile");
  for (const [path, ast] of [["services/ai/Dockerfile", ai], ["services/core/Dockerfile", core], ["infra/compose/gateway.Dockerfile", gateway], ["infra/compose/opa.Dockerfile", opa]]) {
    assertPinnedFroms(ast, path);
    assert.ok(ast.getHEALTHCHECKs().length > 0 || path.includes("opa.Dockerfile"));
  }
  assert.deepEqual(ai.getFROMs().map((from) => from.getImage()), [
    "node:22.17.1-bookworm-slim@sha256:2fa754a9ba4d7adbd2a51d182eaabbe355c82b673624035a38c0d42b08724854",
    "node:22.17.1-bookworm-slim@sha256:2fa754a9ba4d7adbd2a51d182eaabbe355c82b673624035a38c0d42b08724854",
  ]);
  assert.deepEqual(core.getFROMs().map((from) => from.getImage()), [
    "eclipse-temurin:21.0.8_9-jdk-jammy@sha256:adb9b2d15adf1833d9dae0bdc1cff61ef5a804dc58dfbfb34269f32432b2e5dc",
    "eclipse-temurin:21.0.8_9-jre-jammy@sha256:db1689535962d757a5adabf57387584ed543d38c0b9d1fe870123ea362ad73b0",
  ]);
  assert.deepEqual(gateway.getFROMs().map((from) => from.getImage()), [
    "node:22.17.1-bookworm-slim@sha256:2fa754a9ba4d7adbd2a51d182eaabbe355c82b673624035a38c0d42b08724854",
  ]);
  assert.deepEqual(opa.getFROMs().map((from) => from.getImage()), [
    "openpolicyagent/opa:1.5.1-static@sha256:72c5186ef74bc7a88faf88204109476be41cdc392ff1de722f7d8ecb08f18c4d",
    "alpine:3.21.3@sha256:a8560b36e8b8210634f77d9f7f9efd7ffa463e380b75e2e74aff4511df3ef88c",
  ]);

  const aiInstructions = ai.getInstructions();
  const ciIndex = aiInstructions.findIndex((instruction) => instruction.getKeyword() === "RUN" && instruction.getArgumentsContent()?.includes("npm ci"));
  const contractsSourceIndex = aiInstructions.findIndex((instruction) => instruction.getKeyword() === "COPY" && instruction.getArgumentsContent()?.includes("packages/contracts/src"));
  const aiSourceIndex = aiInstructions.findIndex((instruction) => instruction.getKeyword() === "COPY" && instruction.getArgumentsContent()?.includes("services/ai/src"));
  const explicitBuildIndex = aiInstructions.findIndex((instruction) => instruction.getKeyword() === "RUN" && instruction.getArgumentsContent()?.includes("npm run build --workspace @innorder/contracts") && instruction.getArgumentsContent()?.includes("npm run build --workspace @innorder/ai-service"));
  const pruneIndex = aiInstructions.findIndex((instruction) => instruction.getKeyword() === "RUN" && instruction.getArgumentsContent()?.includes("npm prune --omit=dev"));
  const runtimeIndex = aiInstructions.indexOf(ai.getFROMs()[1]);
  assert.ok(contractsSourceIndex >= 0 && contractsSourceIndex < ciIndex);
  assert.ok(aiSourceIndex >= 0 && aiSourceIndex < ciIndex);
  assert.match(aiInstructions[ciIndex].getArgumentsContent(), /npm ci\b[\s\S]*--ignore-scripts/u);
  assert.ok(explicitBuildIndex > contractsSourceIndex && explicitBuildIndex > aiSourceIndex);
  assert.ok(pruneIndex >= explicitBuildIndex && pruneIndex < runtimeIndex);
  assert.equal(ai.getFROMs()[1].getBuildStage(), "runtime");
  const aiRuntimeUser = ai.getInstructions().filter((instruction) => instruction.getKeyword() === "USER").at(-1);
  assert.ok(aiInstructions.indexOf(aiRuntimeUser) > runtimeIndex);
  assert.equal(aiRuntimeUser.getArgumentsContent(), "node");
  assert.deepEqual(ai.getENTRYPOINTs().at(-1).getJSONStrings().map((arg) => arg.getJSONValue()), ["node", "services/ai/dist/server.js"]);

  assert.equal(core.getFROMs()[1].getBuildStage(), "runtime");
  const splitCoreBuild = DockerfileParser.parse(`
RUN --mount=type=cache,target=/root/.gradle,sharing=locked chmod +x gradlew
RUN ./gradlew :services:core:bootJar --no-daemon
`);
  assert.throws(() => assertCoreBootJarUsesGradleCache(splitCoreBuild), /core bootJar RUN must use the locked Gradle cache mount/u);
  assertCoreBootJarUsesGradleCache(core);
  assert.equal(core.getInstructions().filter((instruction) => instruction.getKeyword() === "USER").at(-1).getArgumentsContent(), "10001");
  assert.deepEqual(core.getENTRYPOINTs().at(-1).getJSONStrings().map((arg) => arg.getJSONValue()), ["java", "-jar", "/app/app.jar"]);
  assert.ok(core.getHEALTHCHECKs().at(-1).getArgumentsContent().includes("http://localhost:8080/actuator/health/readiness"));
  assert.ok(!core.getHEALTHCHECKs().at(-1).getArgumentsContent().includes("http://localhost:8080/actuator/health\""));

  assert.equal(gateway.getInstructions().filter((instruction) => instruction.getKeyword() === "USER").at(-1).getArgumentsContent(), "node");
  assert.deepEqual(gateway.getENTRYPOINTs().at(-1).getJSONStrings().map((arg) => arg.getJSONValue()), ["node", "/app/gateway.mjs"]);
  assert.ok(gateway.getHEALTHCHECKs().at(-1).getArgumentsContent().includes("http://localhost:18000/health"));
  assert.equal(opa.getInstructions().filter((instruction) => instruction.getKeyword() === "USER").at(-1).getArgumentsContent(), "10001");
});

test("executes real OPA strict check and behavior tests when OPA_PATH is provided", { skip: !process.env.OPA_PATH }, () => {
  for (const args of [["check", "--strict", "policies/opa"], ["test", "policies/opa"]]) {
    const result = spawnSync(process.env.OPA_PATH, args, { encoding: "utf8" });
    assert.equal(result.status, 0, `${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
});

test("Compose documentation provides exact prerequisite and startup commands", () => {
  const readme = read("infra/compose/README.md");
  assert.match(readme, /Docker Engine/u);
  assert.match(readme, /docker compose --env-file infra\/compose\/\.env -f infra\/compose\/compose\.yml config/u);
  assert.match(readme, /docker compose --env-file infra\/compose\/\.env -f infra\/compose\/compose\.yml up --build/u);
  assert.match(readme, /POSTGRES_ADMIN_PASSWORD_FILE/u);
  assert.match(readme, /POSTGRES_FLYWAY_PASSWORD_FILE/u);
  assert.match(readme, /POSTGRES_RUNTIME_PASSWORD_FILE/u);
  assert.match(readme, /MINIO_APP_PASSWORD_FILE/u);
  assert.match(readme, /Flyway/u);
  assert.match(readme, /Docker Hub\s+Registry API/u);
  assert.match(readme, /Docker-Content-Digest/u);
  assert.match(readme, /linux\/amd64/u);
  assert.match(readme, /Core startup gate is PostgreSQL only/u);
  assert.match(readme, /MinIO\s+initialization and readiness are independent/u);
  assert.doesNotMatch(readme, /Core waits for both MinIO readiness/u);
});
