import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const image = "innorder-parser-task6-test:local";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const docker = (args, options = {}) => spawnSync("docker", args, { cwd: root, encoding: "utf8", timeout: 180_000, ...options });
const mount = (source, target, readonly = false) => `type=bind,src=${source},dst=${target}${readonly ? ",readonly" : ""}`;

async function waitFor(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, "utf8")); } catch { await new Promise((resolvePromise) => setTimeout(resolvePromise, 25)); }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function submit(paths, bytes, fileName = "source.txt", mimeType = "text/plain") {
  const requestId = randomUUID(); const inputSha256 = sha(bytes);
  const inputFile = `${requestId}.${inputSha256}.bin`; const outputFile = `${requestId}.result.json`;
  const request = { version: 1, requestId, inputFile, inputSha256, fileName, mimeType, outputFile };
  const temporary = join(paths.requests, `${requestId}.tmp`);
  await writeFile(join(paths.input, inputFile), bytes);
  await writeFile(temporary, JSON.stringify(request));
  await import("node:fs/promises").then(({ rename }) => rename(temporary, join(paths.requests, `${requestId}.request.json`)));
  return waitFor(join(paths.output, outputFile));
}

test("pinned parser image enforces execution deadlines and remains available", { timeout: 240_000 }, async () => {
  const build = docker(["build", "--file", "services/ai/parser.Dockerfile", "--tag", image, "."]);
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
  const directory = await mkdtemp(join(tmpdir(), "innorder-parser-container-"));
  const paths = { input: join(directory, "input"), requests: join(directory, "requests"), output: join(directory, "output") };
  await Promise.all(Object.values(paths).map((path) => mkdir(path)));
  const name = `innorder-parser-${randomUUID()}`;
  const security = [
    "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--security-opt", `seccomp=${resolve(root, "infra/compose/parser-seccomp.json")}`, "--memory", "512m", "--cpus", "1",
  ];
  const hanging = Buffer.from("deterministic container hanging parser fixture");
  const run = docker(["run", "--detach", "--name", name, ...security,
    "--env", "PARSER_EXECUTION_TIMEOUT_MS=5000", "--env", `PARSER_TEST_HANG_SHA256=${sha(hanging)}`,
    "--mount", mount(paths.input, "/parser/input", true), "--mount", mount(paths.requests, "/parser/requests"),
    "--mount", mount(paths.output, "/parser/output"), image]);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  try {
    const inspect = docker(["inspect", name, "--format", "{{.State.Running}}|{{.HostConfig.ReadonlyRootfs}}|{{.HostConfig.Memory}}|{{.HostConfig.NanoCpus}}|{{.Config.User}}"]);
    assert.equal(inspect.stdout.trim(), "true|true|536870912|1000000000|node");
    const timed = await submit(paths, hanging, "hang.txt", "text/plain");
    assert.equal(timed.ok, false);
    assert.equal(timed.errorCode, "OCC-AI-PARSER-TIMEOUT");

    let golden;
    try { golden = await submit(paths, Buffer.from("container golden")); }
    catch (error) {
      const state = docker(["inspect", name, "--format", "{{json .State}}"]);
      const logs = docker(["logs", name]);
      throw new Error(`${error.message}\nstate=${state.stdout}\nlogs=${logs.stdout}${logs.stderr}`);
    }
    assert.equal(golden.ok, true);
    assert.equal(golden.parsed.text, "container golden");

    const oversized = await submit(paths, Buffer.alloc(17 * 1024 * 1024, 0x61));
    assert.equal(oversized.ok, false);
    assert.match(oversized.errorCode, /^OCC-AI-(?:DOCUMENT|PARSER)-/u);

    const network = docker(["run", "--rm", ...security, "--entrypoint", "node", image, "-e", "require('node:net').connect(80,'1.1.1.1').on('error',e=>process.exit(e.code==='EPERM'||e.code==='EACCES'?0:2))"]);
    assert.equal(network.status, 0, `${network.stdout}\n${network.stderr}`);

    const state = docker(["inspect", name, "--format", "{{.State.Running}}"]);
    assert.equal(state.stdout.trim(), "true");
  } finally {
    docker(["rm", "--force", name]);
    docker(["image", "rm", "--force", image]);
    await rm(directory, { recursive: true, force: true });
  }
});
