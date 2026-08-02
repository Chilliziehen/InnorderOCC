import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const deploymentDirectory = resolve(repositoryRoot, "Docs/Deployment");
const composeSource = await readFile(resolve(repositoryRoot, "infra/compose/compose.yml"), "utf8");
const composeModel = parseYaml(composeSource);
const envExampleSource = await readFile(resolve(repositoryRoot, "infra/compose/.env.example"), "utf8");
const aiAppSource = await readFile(resolve(repositoryRoot, "services/ai/src/app.ts"), "utf8");
const aiProviderSource = await readFile(resolve(repositoryRoot, "services/ai/src/provider-registry.ts"), "utf8");
const coreStatusSource = await readFile(resolve(repositoryRoot, "services/core/src/main/kotlin/com/innorder/occ/system/SystemStatusService.kt"), "utf8");
const chapters = [
  "README.md",
  "01-architecture-and-boundaries.md",
  "02-preflight-and-capacity.md",
  "03-secrets-and-configuration.md",
  "04-deploy-windows.md",
  "05-deploy-linux.md",
  "06-daily-operations-and-monitoring.md",
  "07-backup-restore-and-dr.md",
  "08-upgrade-and-rollback.md",
  "09-incident-runbooks.md",
  "10-security-hardening.md",
  "11-command-reference-and-checklists.md",
];
const credentialPatterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ["JWT", /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u],
  ["service token", /\b(?:sk_(?:live|test)|xox[baprs])[-_A-Za-z0-9]{12,}\b/u],
  ["credential-bearing URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@/iu],
];

let directoryError;
let entries = [];
try {
  entries = await readdir(deploymentDirectory, { withFileTypes: true });
} catch (error) {
  directoryError = error;
}

const documents = new Map();
const readErrors = [];
for (const entry of entries) {
  if (!isRegularChapterEntry(entry) || !entry.name.endsWith(".md")) continue;
  try {
    documents.set(entry.name, await readFile(resolve(deploymentDirectory, entry.name), "utf8"));
  } catch (error) {
    readErrors.push(`${entry.name}: ${error.message}`);
  }
}

function structuralLines(markdown) {
  const outside = [];
  let fence;
  let htmlComment = false;
  let inlineTicks = 0;

  for (const line of markdown.split(/\r?\n/u)) {
    const candidate = !htmlComment && !inlineTicks && line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (!fence && candidate) {
      fence = { character: candidate[1][0], length: candidate[1].length };
      outside.push("");
      continue;
    }
    if (fence && candidate && candidate[1][0] === fence.character
      && candidate[1].length >= fence.length && candidate[2].trim() === "") {
      fence = undefined;
      outside.push("");
      continue;
    }
    if (fence) {
      outside.push("");
      continue;
    }

    let visible = "";
    for (let index = 0; index < line.length;) {
      if (htmlComment) {
        const end = line.indexOf("-->", index);
        if (end < 0) {
          visible += " ".repeat(line.length - index);
          index = line.length;
        } else {
          visible += " ".repeat(end + 3 - index);
          index = end + 3;
          htmlComment = false;
        }
        continue;
      }
      if (inlineTicks) {
        if (line[index] === "`") {
          let length = 1;
          while (line[index + length] === "`") length += 1;
          visible += " ".repeat(length);
          index += length;
          if (length === inlineTicks) inlineTicks = 0;
        } else {
          visible += " ";
          index += 1;
        }
        continue;
      }
      if (line.startsWith("<!--", index)) {
        visible += "    ";
        index += 4;
        htmlComment = true;
        continue;
      }
      if (line[index] === "`" && line[index - 1] !== "\\") {
        let length = 1;
        while (line[index + length] === "`") length += 1;
        visible += " ".repeat(length);
        index += length;
        inlineTicks = length;
        continue;
      }
      visible += line[index];
      index += 1;
    }
    outside.push(visible);
  }

  return outside;
}

function unescapeMarkdown(value) {
  return value.replace(/\\(.)/gu, "$1");
}

function closingBracket(text, start) {
  let depth = 1;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
    } else if (text[index] === "[") {
      depth += 1;
    } else if (text[index] === "]" && --depth === 0) {
      return index;
    }
  }
  return -1;
}

function inlineLinkAt(text, openingBracket) {
  const labelEnd = closingBracket(text, openingBracket + 1);
  if (labelEnd < 0 || text[labelEnd + 1] !== "(") return undefined;
  let index = labelEnd + 2;
  while (/[ \t\n]/u.test(text[index] ?? "")) index += 1;

  let target = "";
  if (text[index] === "<") {
    index += 1;
    while (index < text.length && text[index] !== ">") {
      if (text[index] === "\n") return undefined;
      if (text[index] === "\\" && index + 1 < text.length) target += text[++index];
      else target += text[index];
      index += 1;
    }
    if (text[index] !== ">") return undefined;
    index += 1;
  } else {
    let depth = 0;
    while (index < text.length) {
      const character = text[index];
      if (character === "\\" && index + 1 < text.length) {
        target += text[index + 1];
        index += 2;
        continue;
      }
      if (character === "(") {
        depth += 1;
        target += character;
      } else if (character === ")") {
        if (depth === 0) return { target, end: index };
        depth -= 1;
        target += character;
      } else if (/\s/u.test(character) && depth === 0) {
        break;
      } else {
        target += character;
      }
      index += 1;
    }
    if (depth !== 0) return undefined;
  }

  while (/[ \t\n]/u.test(text[index] ?? "")) index += 1;
  if (text[index] === ")") return { target, end: index };
  const quote = text[index];
  if (!['"', "'", "("].includes(quote)) return undefined;
  const closing = quote === "(" ? ")" : quote;
  index += 1;
  while (index < text.length && text[index] !== closing) {
    if (text[index] === "\\") index += 1;
    index += 1;
  }
  if (text[index] !== closing) return undefined;
  index += 1;
  while (/[ \t\n]/u.test(text[index] ?? "")) index += 1;
  return text[index] === ")" ? { target, end: index } : undefined;
}

function markdownLinkTargets(markdown) {
  const targets = [];
  const text = structuralLines(markdown).join("\n");
  const referenceLink = /^ {0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)/gmu;
  const uriAutolink = /<([A-Z][A-Z0-9+.-]{1,31}:[^<>\s]*)>/giu;
  const emailAutolink = /<([A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)*)>/giu;

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] !== "[") continue;
    const link = inlineLinkAt(text, index);
    if (link) {
      targets.push(link.target);
      index = link.end;
    }
  }
  for (const match of text.matchAll(referenceLink)) targets.push(match[1]);
  for (const match of text.matchAll(uriAutolink)) targets.push(match[1]);
  for (const match of text.matchAll(emailAutolink)) targets.push(`mailto:${match[1]}`);
  return [...new Set(targets.map((target) => {
    const unwrapped = target.startsWith("<") ? target.slice(1, -1) : target;
    return unescapeMarkdown(unwrapped);
  }))];
}

function h1Count(markdown) {
  const lines = structuralLines(markdown);
  let count = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (/^ {0,3}#(?:\s+|$)/u.test(lines[index])) count += 1;
    if (/^ {0,3}=+\s*$/u.test(lines[index]) && index > 0 && lines[index - 1].trim()) count += 1;
  }
  return count;
}

function sectionLabels(markdown) {
  const labels = [];
  for (const line of structuralLines(markdown)) {
    const heading = line.match(/^ {0,3}#{2,6}\s+(.+?)\s*#*\s*$/u);
    if (heading) labels.push(heading[1]);
  }
  return labels;
}

function credentialViolations(markdown) {
  const violations = credentialPatterns.filter(([, pattern]) => pattern.test(markdown)).map(([label]) => label);
  const sensitiveKey = /(?:^|_)(?:PASSWORD|PASSWD|TOKEN|SECRET|ACCESS_KEY|SECRET_KEY|API_KEY)$/u;
  const safeValue = /^(?:\$(?:[A-Z_][A-Z0-9_]*|\{[^{}]+\}|env:[A-Z_][A-Z0-9_]*)|%[A-Z_][A-Z0-9_]*%|<[^<>\r\n]+>|\$?\{\{[^{}\r\n]+\}\}|\[\[[^\]\r\n]+\]\])$/iu;

  for (let line of markdown.split(/\r?\n/u)) {
    line = line.trim().replace(/^[-*+]\s+/u, "");
    if (line.startsWith("`") && line.endsWith("`") && line.length > 1) line = line.slice(1, -1).trim();
    const assignment = line.match(/^(?:export\s+|\$env:)?(?:(["'])([A-Z][A-Z0-9_.-]*)\1|([A-Z][A-Z0-9_.-]*))\s*[:=]\s*(.*?)\s*$/iu);
    if (!assignment) continue;
    const normalizedKey = (assignment[2] ?? assignment[3]).toUpperCase().replace(/[.-]+/gu, "_");
    if (!sensitiveKey.test(normalizedKey)) continue;
    let value = assignment[4].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1).trim();
    }
    if (value && !safeValue.test(value)) violations.push("literal credential assignment");
  }
  return [...new Set(violations)];
}

function isRegularChapterEntry(entry) {
  return entry.isFile() && !entry.isSymbolicLink();
}

function linkTargetResolution(name, target) {
  const pathPart = target.split(/[?#]/u, 1)[0];
  if (!pathPart) return {};
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathPart);
  } catch {
    return { violation: `link has invalid percent encoding: ${target}` };
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(decodedPath) || /^[a-z]:/iu.test(decodedPath)
    || decodedPath.startsWith("/") || decodedPath.startsWith("\\")
    || decodedPath.includes("\\") || isAbsolute(decodedPath) || win32.isAbsolute(decodedPath)) {
    return { violation: `link is not relative: ${target}` };
  }
  const resolvedTarget = resolve(dirname(resolve(deploymentDirectory, name)), decodedPath);
  const fromRepository = relative(repositoryRoot, resolvedTarget);
  if (fromRepository === ".." || fromRepository.startsWith(`..${sep}`) || isAbsolute(fromRepository)) {
    return { violation: `link escapes repository: ${target}` };
  }
  return { resolvedTarget };
}

function codeFenceViolations(markdown, name = "fixture.md") {
  const violations = [];
  let fence;
  let htmlComment = false;
  for (const [index, rawLine] of markdown.split(/\r?\n/u).entries()) {
    let line = rawLine;
    if (!fence) {
      let visible = "";
      for (let offset = 0; offset < line.length;) {
        if (htmlComment) {
          const end = line.indexOf("-->", offset);
          if (end < 0) {
            visible += " ".repeat(line.length - offset);
            offset = line.length;
          } else {
            visible += " ".repeat(end + 3 - offset);
            offset = end + 3;
            htmlComment = false;
          }
        } else {
          const start = line.indexOf("<!--", offset);
          if (start < 0) {
            visible += line.slice(offset);
            offset = line.length;
          } else {
            visible += line.slice(offset, start);
            visible += "    ";
            offset = start + 4;
            htmlComment = true;
          }
        }
      }
      line = visible;
    }
    const candidate = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (!candidate) continue;
    if (!fence) {
      const info = candidate[2].trim();
      if (!/^[A-Z][A-Z0-9_+#.-]*(?:\s|$)/iu.test(info)) {
        violations.push(`${name}:${index + 1}: missing or invalid language identifier`);
      }
      fence = { character: candidate[1][0], length: candidate[1].length, line: index + 1 };
    } else if (candidate[1][0] === fence.character && candidate[1].length >= fence.length
      && candidate[2].trim() === "") {
      fence = undefined;
    }
  }
  if (fence) violations.push(`${name}:${fence.line}: unclosed code fence`);
  return violations;
}

function fencedCodeBlocks(markdown) {
  const blocks = [];
  let fence;
  let content = [];
  for (const line of markdown.split(/\r?\n/u)) {
    const candidate = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (!fence && candidate) {
      fence = { character: candidate[1][0], length: candidate[1].length };
      content = [];
    } else if (fence && candidate && candidate[1][0] === fence.character
      && candidate[1].length >= fence.length && candidate[2].trim() === "") {
      blocks.push(content.join("\n"));
      fence = undefined;
    } else if (fence) {
      content.push(line);
    }
  }
  return blocks;
}

test("structural parsing ignores multiline comments and inline code", () => {
  const markdown = [
    "# Visible title",
    "`# Inline title [inline](inline.md)`",
    "<!--",
    "# Hidden title",
    "## Hidden build",
    "[hidden](hidden.md)",
    "-->",
    "## Visible build",
  ].join("\n");

  assert.equal(h1Count(markdown), 1);
  assert.deepEqual(sectionLabels(markdown), ["Visible build"]);
  assert.deepEqual(markdownLinkTargets(markdown), []);
});

test("inline link tokenizer handles escapes angle destinations and balanced parentheses", () => {
  assert.deepEqual(markdownLinkTargets([
    String.raw`[balanced](chapter_(draft).md)`,
    String.raw`[angle](<chapter (draft).md>)`,
    String.raw`[escaped \] label](chapter_\(draft\).md)`,
    "[chapter]: reference.md",
  ].join("\n")), [
    "chapter_(draft).md",
    "chapter (draft).md",
    "reference.md",
  ]);

  for (const broken of [
    String.raw`[broken](chapter_(draft.md)`,
    String.raw`[broken](<chapter.md)`,
    String.raw`\[escaped](not-a-link.md)`,
  ]) {
    assert.deepEqual(markdownLinkTargets(broken), [], broken);
  }
});

test("decoded link paths cannot be rooted or escape the repository", () => {
  const unsafe = [
    "%2Fetc/passwd",
    "%5CWindows%5Csystem.ini",
    "C:%5CWindows%5Csystem.ini",
    "%5C%5Cserver%5Cshare%5Cmanual.md",
    "../../../outside.md",
  ];
  for (const target of unsafe) {
    assert.ok(linkTargetResolution("README.md", target).violation, target);
  }
  assert.equal(linkTargetResolution("README.md", "../../README.md").resolvedTarget, resolve(repositoryRoot, "README.md"));
});

test("chapter entries must be regular files and never symbolic links", () => {
  const entry = (file, symbolicLink) => ({ isFile: () => file, isSymbolicLink: () => symbolicLink });
  assert.equal(isRegularChapterEntry(entry(true, false)), true);
  assert.equal(isRegularChapterEntry(entry(false, false)), false);
  assert.equal(isRegularChapterEntry(entry(true, true)), false);
});

test("credential scanner rejects prefixed literals but permits references and placeholders", () => {
  const unsafe = [
    "POSTGRES_PASSWORD=CorrectHorseBatteryStaple1!",
    "MINIO_SECRET_KEY='LongStaticSecretValue1!'",
    "POSTGRES_PASSWORD=Correct Horse Battery Staple 1!",
    "MINIO_SECRET_KEY='c2VjcmV0IHZhbHVlLys9PQ=='",
    "SERVICE_API_KEY: sk_live_51ExampleTokenValue",
    "DEPLOY_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456",
    "PASSWORD=example 123",
    "spring.datasource.password=literal value",
    "service.api-key: literal-value",
    "service.api_key=literal_value",
    "\"password\": \"literal value\"",
  ];
  const safe = [
    "POSTGRES_PASSWORD=$POSTGRES_PASSWORD",
    "MINIO_SECRET_KEY='${MINIO_SECRET_KEY}'",
    "REDIS_PASSWORD=\"<operator-supplied-value>\"",
    "APP_TOKEN=$env:APP_TOKEN",
    "API_KEY={{ operator.api_key }}",
    "TOKEN='%DEPLOY_TOKEN%'",
    "spring.datasource.password=${DATABASE_PASSWORD}",
    "service.api-key=$env:SERVICE_API_KEY",
    "service.api_key=<operator-supplied-value>",
    "\"password\": \"{{ secrets.database_password }}\"",
    "This release includes example 123 records.",
  ];

  for (const fixture of unsafe) assert.ok(credentialViolations(fixture).includes("literal credential assignment"), fixture);
  for (const fixture of safe) assert.deepEqual(credentialViolations(fixture), [], fixture);
});

test("Markdown link extraction includes absolute autolinks but ignores angle placeholders", () => {
  const targets = markdownLinkTargets("Visit <https://example.com> or <ops@example.com> using <operator-supplied-path>.");
  assert.deepEqual(targets, [
    "https://example.com",
    "mailto:ops@example.com",
  ]);
  assert.ok(targets.every((target) => /^[a-z][a-z0-9+.-]*:/iu.test(target)));
});

test("code fences require a generic language identifier as the first info token", () => {
  for (const info of ["", "title=example", "=bash", ".bash"]) {
    assert.notDeepEqual(codeFenceViolations(`\`\`\`${info}\nvalue\n\`\`\``), [], info || "empty");
  }
  for (const info of ["toml", "ini", "shell-session", "c++", "powershell title=example"]) {
    assert.deepEqual(codeFenceViolations(`\`\`\`${info}\nvalue\n\`\`\``), [], info);
  }
});

test("code fence validation ignores HTML comments but checks real fences", () => {
  const markdown = [
    "<!-- ``` title=single-line -->",
    "<!--",
    "``` title=hidden",
    "```",
    "-->",
    "``` title=real",
    "```",
  ].join("\n");
  assert.deepEqual(codeFenceViolations(markdown), [
    "fixture.md:6: missing or invalid language identifier",
  ]);
});

test("deployment lifecycle labels come only from visible H2-H6 headings", () => {
  assert.deepEqual(sectionLabels("# Title\n\n<!-- deployment-contract:prerequisites -->\n\n## Build"), ["Build"]);
});

test("deployment manual contains exactly the required twelve files", () => {
  const actual = entries.map((entry) => entry.name);
  const entryByName = new Map(entries.map((entry) => [entry.name, entry]));
  assert.deepEqual({
    directoryError: directoryError?.code ?? null,
    missing: chapters.filter((chapter) => !actual.includes(chapter)),
    invalid: chapters.filter((chapter) => entryByName.has(chapter) && !isRegularChapterEntry(entryByName.get(chapter))),
    unexpected: actual.filter((entry) => !chapters.includes(entry)),
    unreadable: readErrors,
  }, {
    directoryError: null,
    missing: [],
    invalid: [],
    unexpected: [],
    unreadable: [],
  });
});

test("every available chapter contains exactly one H1", () => {
  const invalid = [];
  for (const [name, markdown] of documents) {
    const count = h1Count(markdown);
    if (count !== 1) invalid.push(`${name}: found ${count} H1 headings`);
  }
  assert.deepEqual(invalid, []);
});

test("README links every numbered chapter by its exact relative path", () => {
  const readme = documents.get("README.md");
  assert.ok(readme, "Docs/Deployment/README.md must exist before navigation can be checked");
  const targets = new Set(markdownLinkTargets(readme).map((target) => target.split(/[?#]/u, 1)[0]));
  const missing = chapters.slice(1).filter((chapter) => !targets.has(chapter));
  assert.deepEqual(missing, []);
});

test("manual contains no unfinished markers or realistic credential literals", () => {
  const violations = [];

  for (const [name, markdown] of documents) {
    if (/\b(?:TBD|TODO|FIXME|changeme)\b/iu.test(markdown)) {
      violations.push(`${name}: unfinished placeholder`);
    }
    for (const label of credentialViolations(markdown)) violations.push(`${name}: ${label}`);
  }
  assert.deepEqual(violations, []);
});

test("manual records the required Compose and operational facts", () => {
  const corpus = [...documents.values()].join("\n");
  const exactFacts = [
    "host-gateway", "backend", "host-access",
    "POSTGRES_ADMIN_PASSWORD_FILE", "POSTGRES_FLYWAY_PASSWORD_FILE",
    "POSTGRES_RUNTIME_PASSWORD_FILE", "REDIS_PASSWORD_FILE",
    "MINIO_ROOT_USER_FILE", "MINIO_ROOT_PASSWORD_FILE",
    "MINIO_APP_USER_FILE", "MINIO_APP_PASSWORD_FILE",
    "postgres-data", "kafka-data", "redis-data", "minio-data",
    "innorder_admin", "innorder_flyway", "innorder_runtime",
    "http://127.0.0.1:8080/actuator/health/readiness",
    "http://127.0.0.1:3100/health",
    "http://127.0.0.1:8181/health",
    "http://127.0.0.1:9000/minio/health/ready",
    "verify:full",
  ];
  const missing = exactFacts.filter((fact) => !corpus.includes(fact));
  for (const port of [5432, 9092, 6379, 9000, 9001, 8181, 3100, 8080]) {
    if (!new RegExp(`\\b${port}\\b`, "u").test(corpus)) missing.push(`default port ${port}`);
  }

  const destructiveWarning = corpus.split(/\r?\n\s*\r?\n/u).some((paragraph) =>
    paragraph.includes("down --volumes")
      && /危险|破坏|永久|删除|不可恢复|destructive|delete|erase/iu.test(paragraph));
  if (!destructiveWarning) missing.push("explicit destructive warning for down --volumes");
  assert.deepEqual(missing, []);

  const incidents = documents.get("09-incident-runbooks.md");
  const security = documents.get("10-security-hardening.md");
  const reference = documents.get("11-command-reference-and-checklists.md");
  assert.ok(incidents && security && reference);

  assert.match(incidents, /\$Ports\s*=\s*\[ordered\]@\{/u);
  assert.match(incidents, /POSTGRES_PORT=\$\{config\[POSTGRES_PORT\]:-5432\}/u);
  assert.doesNotMatch(incidents, /http:\/\/127[.]0[.]0[.]1:(?:8080|3100|8181|9000)\//u);
  assert.doesNotMatch(incidents, /--port 5432\s+--dbname innorder_occ/u);
  assert.match(incidents, /nspname = '\\''flowable'\\''/u);
  assert.match(incidents, /schema_name = '\\''flowable'\\''/u);

  assert.match(security, /lines=\$\(ss -H -ltn "sport = :\$port" 2>&1\)/u);
  assert.match(security, /awk 'NF \{print \$4\}'/u);
  assert.match(security, /\[ "\$local_address" = "127[.]0[.]0[.]1:\$port" \]/u);
  assert.match(security, /POSTGRES_PORT=\$\{config\[POSTGRES_PORT\]:-5432\}/u);

  const destructiveLinux = reference.match(/Linux Bash：\s+```bash([\s\S]*?)```\s+\*\*验证：\*\*/u)?.[1] ?? "";
  assert.match(destructiveLinux, /systemctl list-jobs/u);
  assert.match(destructiveLinux, /activating\|deactivating\|reloading/u);
  assert.match(destructiveLinux, /config --quiet/u);
  assert.doesNotMatch(destructiveLinux, /systemctl (?:stop|disable)|\bdown\b/u);

  assert.match(reference, /exec -T kafka \/opt\/kafka\/bin\/kafka-topics[.]sh --bootstrap-server localhost:29092 --list/u);
  assert.doesNotMatch(reference, /^kafka-topics(?:[.]sh)? --bootstrap-server/mu);
});

test("repository sources drive the documented deployment facts", () => {
  const corpus = [...documents.values()].join("\n");
  const architecture = documents.get("01-architecture-and-boundaries.md");
  const envKeys = envExampleSource.split(/\r?\n/u)
    .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/u)?.[1])
    .filter(Boolean);
  const aiRoutes = [...aiAppSource.matchAll(/app[.]get\("([/]\S+?)"/gu)].map((match) => match[1]);
  const publishedDefaults = composeModel.services["host-gateway"].ports.map((entry) => {
    const match = String(entry).match(/\$\{[A-Z0-9_]+:-([0-9]+)\}/u);
    assert.ok(match, `host-gateway port has no default: ${entry}`);
    return match[1];
  });
  const sourceFacts = [
    ...Object.keys(composeModel.services),
    ...Object.keys(composeModel.volumes),
    ...Object.keys(composeModel.networks),
    ...Object.keys(composeModel.secrets),
    ...envKeys,
    ...aiRoutes,
    ...publishedDefaults,
  ];
  assert.deepEqual(sourceFacts.filter((fact) => !corpus.includes(fact)), []);
  assert.equal(Object.keys(composeModel.services).length, 13);
  assert.equal(composeModel.services.backend, undefined);
  assert.equal(composeModel.networks.backend.internal, true);
  assert.equal(composeModel.services["host-gateway"].ports.length, 8);
  for (const service of Object.keys(composeModel.services)) {
    assert.match(architecture, new RegExp("^\\| `" + service + "` \\|", "mu"), `missing architecture row for ${service}`);
  }
  for (const publication of composeModel.services["host-gateway"].ports) {
    const mapping = String(publication).match(/^(127[.]0[.]0[.]1:\$\{[^}]+\}):([0-9]+)$/u);
    assert.ok(mapping, `invalid source publication ${publication}`);
    assert.ok(architecture.includes(`| \`${mapping[1]}\` | \`${mapping[2]}\` |`), `missing exact host publication ${publication}`);
  }
  for (const volume of Object.keys(composeModel.volumes)) {
    const consumers = Object.entries(composeModel.services)
      .filter(([, service]) => (service.volumes ?? []).some((mount) => String(mount).startsWith(`${volume}:`)))
      .map(([name]) => name);
    const row = architecture.split(/\r?\n/u).find((line) => line.startsWith(`| \`${volume}\` |`)) ?? "";
    assert.ok(row, `missing volume row ${volume}`);
    for (const consumer of consumers) assert.ok(row.includes(`\`${consumer}\``), `${volume} missing consumer ${consumer}`);
  }
  assert.match(aiProviderSource, /supportsTools:\s*true/u);
  assert.match(corpus, /supportsTools[^\n]{0,120}(?:固定|静态|不是运行探测)/u);
  assert.match(corpus, /没有 model factory/u);

  const dependencySection = coreStatusSource.match(/DEPENDENCIES\s*=\s*listOf\(([\s\S]*?)\n\s*\)/u)?.[1] ?? "";
  const coreDependencyIds = [...dependencySection.matchAll(/"([a-z0-9-]+)"\s+to\s+"/gu)].map((match) => match[1]);
  assert.deepEqual(coreDependencyIds, ["postgresql", "flowable", "opa", "kafka", "redis", "minio"]);
  const reference = documents.get("11-command-reference-and-checklists.md");
  for (const id of ["core-runtime", ...coreDependencyIds]) assert.ok(reference.includes(`'${id}'`), id);
  assert.doesNotMatch(documents.get("09-incident-runbooks.md"), /Core (?:到|聚合状态探测)[^\n]{0,80}AI/u);
});

test("executable volume destruction exists only in the command reference", () => {
  const violations = [];
  for (const [name, markdown] of documents) {
    if (name === "11-command-reference-and-checklists.md") continue;
    for (const block of fencedCodeBlocks(markdown)) {
      if (/\bdown\s+--volumes\b/u.test(block)) violations.push(name);
    }
  }
  assert.deepEqual([...new Set(violations)], []);

  const reference = documents.get("11-command-reference-and-checklists.md");
  assert.ok(reference, "command reference must exist");
  const destructiveBlocks = fencedCodeBlocks(reference).filter((block) => /\bdown\s+--volumes\b/u.test(block));
  assert.deepEqual(destructiveBlocks, [], "manual must not provide executable permanent volume deletion");

  const allExecutable = [...documents.values()].flatMap(fencedCodeBlocks).join("\n");
  assert.doesNotMatch(allExecutable, /docker\s+(?:volume\s+(?:rm|prune)|system\s+prune)\b/u);
  assert.match(reference, /当前不提供删除实现/u);
});

test("state-changing procedures share the project lifecycle lock", () => {
  const required = {
    "03-secrets-and-configuration.md": /Enter-LifecycleLock[\s\S]*acquire_lifecycle_lock/u,
    "04-deploy-windows.md": /innorder-occ-lifecycle[.]lock/u,
    "05-deploy-linux.md": /flock[\s\S]*innorder-occ-lifecycle[.]lock/u,
    "07-backup-restore-and-dr.md": /innorder-occ-lifecycle[.]lock[\s\S]*flock -n/u,
    "08-upgrade-and-rollback.md": /innorder-occ-lifecycle[.]lock[\s\S]*flock -n/u,
    "11-command-reference-and-checklists.md": /innorder-occ-lifecycle[.]lock/u,
  };
  const missing = Object.entries(required)
    .filter(([name, pattern]) => !pattern.test(documents.get(name) ?? ""))
    .map(([name]) => name);
  assert.deepEqual(missing, []);
  assert.match(documents.get("05-deploy-linux.md"),
    /ExecStart=\/usr\/bin\/flock[\s\S]*ExecStop=\/usr\/bin\/flock/u);
});

test("restore and MinIO rotation retain the reviewed safety gates", () => {
  const recovery = documents.get("07-backup-restore-and-dr.md");
  const configuration = documents.get("03-secrets-and-configuration.md");
  const security = documents.get("10-security-hardening.md");
  assert.match(recovery, /compose-env-nonsecret[.]txt/u);
  assert.match(recovery, /backup-consistency-evidence[.]txt/u);
  assert.match(recovery, /Stack\[string\][\s\S]*ReparsePoint/u);
  assert.match(configuration, /mc pipe[\s\S]*mc cat[\s\S]*mc rm/u);
  assert.match(security, /MinIO 短时 argv 风险/u);
  assert.match(recovery, /source-object-manifest[.]jsonl/u);
});

test("incident and Linux lifecycle writes use the shared lock ownership paths", () => {
  const incidents = documents.get("09-incident-runbooks.md");
  const linux = documents.get("05-deploy-linux.md");
  assert.doesNotMatch(incidents, /(?:@ComposeArgs|\$\{compose\[@\]\})\s+stop\s+core/u);
  assert.ok((incidents.match(/Stop-CoreForIncident/gmu) ?? []).length >= 4);
  assert.ok((incidents.match(/stop_core_for_incident/gmu) ?? []).length >= 4);
  assert.match(linux, /active\) sudo systemctl stop innorder-occ[.]service/u);
  assert.match(linux, /inactive\|failed\) acquire_lifecycle_lock; "\$\{compose\[@\]\}" stop/u);
  assert.match(linux, /acquire_lifecycle_lock[\s\S]{0,300}down --remove-orphans[\s\S]{0,1800}docker volume ls[\s\S]{0,300}release_lifecycle_lock/u);
});

for (const chapter of ["04-deploy-windows.md", "05-deploy-linux.md"]) {
  test(`${chapter} has structural headings for the platform deployment lifecycle`, () => {
    const markdown = documents.get(chapter);
    assert.ok(markdown, `Docs/Deployment/${chapter} must exist`);
    const labels = sectionLabels(markdown);
    const requiredSections = {
      prerequisites: /前(?:置|提)条件|先决条件|prerequisites?/iu,
      secrets: /密钥|凭据|secrets?|credentials?/iu,
      configuration: /配置|configuration|config/iu,
      build: /构建|build/iu,
      start: /启动|start/iu,
      status: /状态|status/iu,
      "http-probe": /HTTP.{0,12}(?:探测|检查|验证|probe|health)|(?:探测|检查|验证).{0,12}HTTP/iu,
      "protocol-probe": /(?:TCP|协议).{0,12}(?:探测|检查|验证|probe)|(?:探测|检查|验证).{0,12}(?:TCP|协议)/iu,
      restart: /重启|restart/iu,
      logs: /日志|logs?/iu,
      stop: /停止|停机|关闭|stop|shutdown/iu,
      "data-deletion": /数据.{0,8}(?:删除|清理|销毁)|(?:删除|清理|销毁).{0,8}数据|data deletion|destructive cleanup/iu,
    };
    const missing = Object.entries(requiredSections)
      .filter(([, pattern]) => !labels.some((label) => pattern.test(label)))
      .map(([marker]) => marker);
    assert.deepEqual(missing, [], `${chapter} is missing required H2-H6 sections`);
  });
}

test("all Markdown links are relative and resolve", async () => {
  const violations = [];
  for (const [name, markdown] of documents) {
    for (const target of markdownLinkTargets(markdown)) {
      const { resolvedTarget, violation } = linkTargetResolution(name, target);
      if (violation) {
        violations.push(`${name}: ${violation}`);
        continue;
      }
      if (!resolvedTarget) continue;
      try {
        await stat(resolvedTarget);
      } catch {
        violations.push(`${name}: unresolved link: ${target}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("every fenced code block has a language tag and closing fence", () => {
  const violations = [];
  for (const [name, markdown] of documents) {
    violations.push(...codeFenceViolations(markdown, name));
  }
  assert.deepEqual(violations, []);
});
