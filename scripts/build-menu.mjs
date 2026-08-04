#!/usr/bin/env node
/**
 * Interactive build menu for the Innorder OCC repository.
 *
 * Launched by build.bat, but usable directly with `node scripts/build-menu.mjs`
 * on any platform. Every target is also addressable by name so the same entry
 * point works from CI, a shortcut, or a shell.
 *
 * The desktop client is Windows x64 only. That is a repository constraint, not
 * a limitation of this menu: scripts/electron-provenance.mjs accepts only the
 * official electron-v43.2.0-win32-x64.zip, and forge.config.ts registers a
 * single Squirrel maker scoped to win32.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

const WINDOWS = process.platform === "win32";
const GRADLE = WINDOWS ? ".\\gradlew.bat" : "./gradlew";

const IMAGES = [
  ["core", "services/core/Dockerfile"],
  ["ai", "services/ai/Dockerfile"],
  ["parser", "services/ai/parser.Dockerfile"],
  ["opa", "infra/compose/opa.Dockerfile"],
  ["gateway", "infra/compose/gateway.Dockerfile"],
];

const BUILD_OUTPUTS = [
  "dist/release",
  "apps/desktop/out",
  "apps/desktop/out-smoke",
  "apps/desktop/.vite",
  "packages/contracts/dist",
  "services/ai/dist",
  "services/core/build",
];

// ---------------------------------------------------------------- utilities

function say(line = "") {
  process.stdout.write(`${line}\n`);
}

// CJK glyphs occupy two terminal columns, so padding has to count display
// width rather than code units or the menu columns drift.
function displayWidth(text) {
  let width = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    const wide = (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

function pad(text, columns) {
  return text + " ".repeat(Math.max(0, columns - displayWidth(text)));
}

function run(command, args) {
  say(`\n  $ ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    // npm and gradlew are shell wrappers on Windows.
    shell: WINDOWS,
  });
  if (result.error) throw new Error(result.error.message);
  return result.status ?? 1;
}

function npm(...args) {
  return run("npm", args);
}

function have(command, args) {
  const result = spawnSync(command, args, { stdio: "ignore", shell: WINDOWS });
  return result.status === 0;
}

function requireNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) return `需要 Node.js 22 或更高版本，当前为 ${process.versions.node}`;
  return null;
}

function requireGradle() {
  return existsSync(join(ROOT, WINDOWS ? "gradlew.bat" : "gradlew"))
    ? null
    : "未找到 Gradle wrapper";
}

function requireDocker() {
  return have("docker", ["info"]) ? null : "Docker Engine 未运行或不可访问";
}

function requireOpa() {
  if (process.env.OPA_PATH || have("opa", ["version"])) return null;
  return "full 验证要求真实 opa 可执行文件：请安装 opa 或设置 OPA_PATH";
}

function buildImage(name, dockerfile) {
  return run("docker", ["build", "--file", dockerfile, "--tag", `innorder-occ-${name}:dev`, "."]);
}

function clean() {
  for (const relative of BUILD_OUTPUTS) {
    const path = join(ROOT, relative);
    if (!existsSync(path)) continue;
    say(`    - ${relative}`);
    rmSync(path, { recursive: true, force: true });
  }
  say("  保留 node_modules 与 .cache；如需重装依赖请选择“安装依赖”。");
  return 0;
}

function installDependencies() {
  const registry = spawnSync("npm", ["config", "get", "registry"], {
    encoding: "utf8",
    shell: WINDOWS,
  }).stdout?.trim();
  say(`  当前 npm registry: ${registry || "未知"}`);
  if (registry && !registry.includes("registry.npmjs.org")) {
    say("");
    say("  [警告] registry 不是官方源。install:verified 会强制使用官方源，");
    say("         但若改用普通 npm install，lockfile 的 resolved 地址会被镜像");
    say("         改写，破坏仓库的来源保证（test:provenance 会失败）。");
    say("");
  }
  // install:verified establishes its own cache and provenance boundary.
  const inherited = process.env.npm_config_cache;
  delete process.env.npm_config_cache;
  try {
    return npm("run", "install:verified");
  } finally {
    if (inherited !== undefined) process.env.npm_config_cache = inherited;
  }
}

// ------------------------------------------------------------------ targets

const TARGETS = new Map();

function target(name, label, description, requires, action) {
  TARGETS.set(name, { name, label, description, requires, action });
}

target("release", "完整 release", "Core jar + AI + 桌面 + SHA256 清单",
  [requireNode, requireGradle], () => run("node", ["scripts/deploy/release.mjs"]));
target("release-backend", "后端 release", "跳过桌面打包，速度快",
  [requireNode, requireGradle], () => run("node", ["scripts/deploy/release.mjs", "--skip-desktop"]));

target("contracts", "共享契约", "@innorder/contracts",
  [requireNode], () => npm("run", "build", "--workspace", "@innorder/contracts"));
target("ai", "AI 服务", "先构建契约，再编译 AI 服务", [requireNode], () => {
  const contracts = npm("run", "build", "--workspace", "@innorder/contracts");
  return contracts === 0 ? npm("run", "build", "--workspace", "@innorder/ai-service") : contracts;
});
target("core", "Core boot jar", "strict 依赖校验", [requireNode, requireGradle],
  () => run(GRADLE, [":services:core:bootJar", "--dependency-verification", "strict"]));
target("desktop", "桌面目录包", "Windows x64",
  [requireNode], () => npm("run", "package", "--workspace", "@innorder/desktop"));
target("desktop-installer", "桌面安装程序", "Windows x64 Squirrel",
  [requireNode], () => npm("run", "make", "--workspace", "@innorder/desktop"));

target("images", "全部容器镜像", "core / ai / parser / opa / gateway，linux/amd64",
  [requireDocker], () => {
    for (const [name, dockerfile] of IMAGES) {
      const status = buildImage(name, dockerfile);
      if (status !== 0) return status;
    }
    return 0;
  });
for (const [name, dockerfile] of IMAGES) {
  target(`image-${name}`, `镜像 ${name}`, dockerfile, [requireDocker],
    () => buildImage(name, dockerfile));
}

target("verify", "quick 验证", "离线友好", [requireNode], () => npm("run", "verify"));
target("verify-local", "local 验证", "允许 Docker/OPA 缺失时跳过",
  [requireNode], () => npm("run", "verify:local"));
target("verify-full", "full 验证", "要求 Docker + OPA，禁止跳过",
  [requireNode, requireDocker, requireOpa], () => npm("run", "verify:full"));
target("typecheck", "类型检查", "全部 TypeScript workspace",
  [requireNode], () => npm("run", "typecheck"));

target("install", "安装依赖", "npm run install:verified", [requireNode], installDependencies);
target("clean", "清理构建产物", "保留 node_modules 与缓存", [], clean);

const MENU = [
  ["发布包", ["release", "release-backend"]],
  ["单组件", ["contracts", "ai", "core", "desktop", "desktop-installer"]],
  ["容器镜像", ["images", "image-core", "image-ai", "image-parser", "image-opa", "image-gateway"]],
  ["验证", ["verify", "verify-local", "verify-full", "typecheck"]],
  ["维护", ["install", "clean"]],
];

// -------------------------------------------------------------------- driver

function execute(name) {
  const entry = TARGETS.get(name);
  if (!entry) {
    say(`  未知目标: ${name}`);
    say("  运行 build.bat help 查看全部目标。");
    return 2;
  }

  for (const check of entry.requires) {
    const problem = check();
    if (problem) {
      say(`\n  [缺少前置条件] ${problem}`);
      return 1;
    }
  }

  say(`\n  ==== ${entry.label} (${entry.name}) ====`);
  const startedAt = Date.now();
  let status;
  try {
    status = entry.action();
  } catch (error) {
    say(`\n  [异常] ${error.message}`);
    return 1;
  }
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  say(status === 0
    ? `\n  [完成] ${entry.label}  用时 ${seconds}s`
    : `\n  [失败] ${entry.label}  退出码 ${status}  用时 ${seconds}s`);
  return status;
}

function usage() {
  say("");
  say("  用法: build.bat [目标]        不带参数则打开交互菜单");
  say("");
  for (const [group, names] of MENU) {
    say(`  ${group}`);
    for (const name of names) {
      const entry = TARGETS.get(name);
      say(`    ${pad(name, 19)} ${entry.label} — ${entry.description}`);
    }
    say("");
  }
  say("  桌面客户端固定为 Windows x64：仓库的 Electron 来源允许清单只接受");
  say("  官方 win32-x64 构建，且只注册了 win32 的 Squirrel maker。");
  say("");
  return 0;
}

async function menu() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const choices = [];
      say("");
      say("  ============================================================");
      say("   创序 OCC 构建菜单");
      say("  ============================================================");
      for (const [group, names] of MENU) {
        say("");
        say(`   ${group}`);
        for (const name of names) {
          const entry = TARGETS.get(name);
          choices.push(name);
          const index = String(choices.length).padStart(2, " ");
          say(`    ${index}) ${pad(entry.label, 18)} ${entry.description}`);
        }
      }
      say("");
      say("     0) 退出");
      say("");

      const answer = (await rl.question("  请选择: ")).trim();
      if (answer === "0" || answer.toLowerCase() === "q") return 0;
      if (answer === "") continue;

      const byNumber = Number.parseInt(answer, 10);
      const name = Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= choices.length
        ? choices[byNumber - 1]
        : answer;

      execute(name);
      await rl.question("\n  按回车返回菜单… ");
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const problem = requireNode();
  if (problem) {
    say(`  [缺少前置条件] ${problem}`);
    process.exit(1);
  }
  if (!existsSync(join(ROOT, ".cache"))) mkdirSync(join(ROOT, ".cache"), { recursive: true });

  const [first] = process.argv.slice(2);
  if (first === "help" || first === "--help" || first === "-h") process.exit(usage());
  if (first) process.exit(execute(first));
  if (!process.stdin.isTTY) {
    say("  标准输入不是终端，无法打开交互菜单。请直接指定目标，例如：build.bat release");
    process.exit(usage());
  }
  process.exit(await menu());
}

await main();
