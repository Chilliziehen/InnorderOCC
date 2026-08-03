import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const compose = ["compose", "-f", "infra/compose/compose.yml"];
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function run(args, environment, timeout = 600_000) {
  const result = spawnSync("docker", args, { cwd: repositoryRoot, env: environment, encoding: "utf8", timeout });
  assert.equal(result.status, 0, `${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

test("real Compose parser deployment is ready, isolated, bounded, and usable by AI", { timeout: 900_000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), "innorder-parser-compose-"));
  const secret = join(directory, "secret"); writeFileSync(secret, "compose-test-only");
  const project = `innorder-parser-${process.pid}`;
  const environment = { ...process.env };
  for (const name of ["POSTGRES_ADMIN_PASSWORD_FILE", "AI_DATABASE_PASSWORD_FILE", "POSTGRES_FLYWAY_PASSWORD_FILE", "POSTGRES_RUNTIME_PASSWORD_FILE", "REDIS_PASSWORD_FILE", "MINIO_ROOT_USER_FILE", "MINIO_ROOT_PASSWORD_FILE", "MINIO_APP_USER_FILE", "MINIO_APP_PASSWORD_FILE"]) environment[name] = secret;
  const prefix = [...compose, "-p", project];
  try {
    run([...prefix, "config", "--quiet"], environment, 120_000);
    run([...prefix, "up", "--build", "--detach", "--wait", "parser", "ai"], environment);
    const parser = `${project}-parser-1`; const ai = `${project}-ai-1`;
    const inspect = run(["inspect", parser, "--format", "{{.HostConfig.NetworkMode}}|{{.HostConfig.ReadonlyRootfs}}|{{.HostConfig.Memory}}|{{.HostConfig.NanoCpus}}|{{.HostConfig.PidsLimit}}|{{.Config.User}}|{{json .HostConfig.CapDrop}}|{{json .HostConfig.SecurityOpt}}"], environment, 120_000);
    assert.match(inspect, /^none\|true\|536870912\|1000000000\|64\|node\|\["ALL"\]\|/u);
    assert.match(inspect, /no-new-privileges:true/u); assert.match(inspect, /seccomp=/u);
    const script = "import { ParserSidecarClient } from './services/ai/dist/ingestion/parser-sidecar.js'; const keep=setInterval(()=>{},1000); try { const c=new ParserSidecarClient({inputRoot:'/parser/input',requestRoot:'/parser/requests',outputRoot:'/parser/output'}); await c.assertReady(); const r=await c.parse({bytes:Buffer.from('compose parser runtime'),fileName:'runtime.txt',mimeType:'text/plain'},new AbortController().signal); if(r.text!=='compose parser runtime')process.exitCode=1; else console.log(r.parserVersion); c.close(); } finally { clearInterval(keep); }";
    assert.equal(run(["exec", ai, "node", "--input-type=module", "-e", script], environment, 120_000), "governed-parser-v1");
  } finally {
    spawnSync("docker", [...prefix, "down", "--volumes", "--remove-orphans"], { cwd: repositoryRoot, env: environment, encoding: "utf8", timeout: 180_000 });
    rmSync(directory, { recursive: true, force: true });
  }
});
