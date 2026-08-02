import { constants, existsSync } from "node:fs";
import { open, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Worker, type ResourceLimits } from "node:worker_threads";

import {
  canonicalParsed, MAX_PARSER_INPUT_BYTES, MAX_PARSER_REQUEST_BYTES, MAX_PARSER_RESULT_BYTES,
  PARSER_PROTOCOL_VERSION, ParsedDocumentSchema, ParserRequestSchema, sha256, type ParserRequest, type ParserResult,
} from "./parser-protocol.js";
import { atomicWrite, removeStaleAtomicTemps } from "./atomic-file.js";

type TestHook = "hang" | "memory" | "output";
type ExecutionOptions = Readonly<{
  executionTimeoutMs?: number; maxResultBytes?: number; taskUrl?: URL; resourceLimits?: ResourceLimits;
  testHooks?: Readonly<Partial<Record<TestHook, string>>>;
}>;
type WorkerOptions = Readonly<{ inputRoot: string; requestRoot: string; outputRoot: string; pollMs?: number }> & ExecutionOptions;
type ResolvedExecution = Readonly<{
  executionTimeoutMs: number; maxResultBytes: number; taskUrl: URL; resourceLimits: ResourceLimits;
  testHooks: Readonly<Partial<Record<TestHook, string>>> | undefined;
}>;

async function root(path: string): Promise<string> {
  const resolved = await realpath(path);
  const metadata = await stat(resolved);
  if (!metadata.isDirectory()) throw new Error("OCC-AI-PARSER-CONFIG");
  return resolved;
}

function child(rootPath: string, name: string): string {
  if (basename(name) !== name || name.includes("\0") || (name !== ".parser-heartbeat.json" && name.startsWith("."))) throw new Error("OCC-AI-PARSER-ENVELOPE");
  const path = resolve(rootPath, name);
  if (dirname(path) !== rootPath) throw new Error("OCC-AI-PARSER-ENVELOPE");
  return path;
}

async function readRequest(path: string): Promise<{ request: ParserRequest; bytes: Buffer }> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_PARSER_REQUEST_BYTES) throw new Error("OCC-AI-PARSER-ENVELOPE");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = await handle.readFile();
    return { request: ParserRequestSchema.parse(JSON.parse(bytes.toString("utf8"))), bytes };
  } catch { throw new Error("OCC-AI-PARSER-ENVELOPE"); } finally { await handle.close(); }
}

function executionConfig(options: ExecutionOptions): ResolvedExecution {
  const executionTimeoutMs = options.executionTimeoutMs ?? 60_000;
  const maxResultBytes = options.maxResultBytes ?? MAX_PARSER_RESULT_BYTES;
  const resourceLimits = options.resourceLimits ?? { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 };
  if (!Number.isSafeInteger(executionTimeoutMs) || executionTimeoutMs < 10 || executionTimeoutMs > 60_000 || !Number.isSafeInteger(maxResultBytes) || maxResultBytes < 256 || maxResultBytes > MAX_PARSER_RESULT_BYTES) throw new Error("OCC-AI-PARSER-CONFIG");
  if (resourceLimits.maxOldGenerationSizeMb !== undefined && (resourceLimits.maxOldGenerationSizeMb < 16 || resourceLimits.maxOldGenerationSizeMb > 384)) throw new Error("OCC-AI-PARSER-CONFIG");
  return { executionTimeoutMs, maxResultBytes, taskUrl: options.taskUrl ?? new URL("./parser-task.js", import.meta.url), resourceLimits, testHooks: options.testHooks };
}

function executeParse(inputBytes: Uint8Array, request: ParserRequest, requestPath: string, signal: AbortSignal, options: ExecutionOptions): Promise<unknown> {
  const config = executionConfig(options);
  const hook = (Object.entries(config.testHooks ?? {}) as [TestHook, string][]).find(([, digest]) => digest === request.inputSha256)?.[0];
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(config.taskUrl, {
      workerData: { bytes: inputBytes, fileName: request.fileName, mimeType: request.mimeType, hook },
      resourceLimits: config.resourceLimits,
    });
    let settled = false;
    const finish = (error?: Error, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearInterval(cancelPoll);
      signal.removeEventListener("abort", aborted);
      void worker.terminate();
      if (error) reject(error); else resolvePromise(value);
    };
    const aborted = () => finish(new Error("OCC-AI-PARSER-CANCELLED"));
    const deadline = setTimeout(() => finish(new Error("OCC-AI-PARSER-TIMEOUT")), config.executionTimeoutMs);
    const cancelPoll = setInterval(() => { if (!existsSync(requestPath)) finish(new Error("OCC-AI-PARSER-CANCELLED")); }, 10);
    signal.addEventListener("abort", aborted, { once: true });
    worker.once("message", (message: unknown) => {
      if (typeof message !== "object" || message === null || !("ok" in message)) return finish(new Error("OCC-AI-PARSER-FAILED"));
      if (message.ok === false && "errorCode" in message && typeof message.errorCode === "string") return finish(new Error(message.errorCode));
      if (message.ok === true && "parsed" in message) return finish(undefined, message.parsed);
      return finish(new Error("OCC-AI-PARSER-FAILED"));
    });
    worker.once("error", () => finish(new Error("OCC-AI-PARSER-RESOURCE")));
    worker.once("exit", (code) => { if (code !== 0) finish(new Error("OCC-AI-PARSER-RESOURCE")); });
    if (signal.aborted) aborted();
  });
}

export async function processParserRequest(requestPath: string, inputRoot: string, outputRoot: string, options: ExecutionOptions = {}, signal = new AbortController().signal): Promise<void> {
  const { request, bytes: requestBytes } = await readRequest(requestPath);
  if (![`${request.requestId}.request.json`, `${request.requestId}.processing.json`].includes(basename(requestPath))) throw new Error("OCC-AI-PARSER-ENVELOPE");
  const inputPath = child(inputRoot, request.inputFile);
  const outputPath = child(outputRoot, request.outputFile);
  const inputMetadata = await stat(inputPath);
  if (!inputMetadata.isFile() || inputMetadata.size < 1 || inputMetadata.size > MAX_PARSER_INPUT_BYTES) throw new Error("OCC-AI-PARSER-INPUT");
  const handle = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let inputBytes: Buffer;
  try { inputBytes = await handle.readFile(); } finally { await handle.close(); }
  if (sha256(inputBytes) !== request.inputSha256) throw new Error("OCC-AI-PARSER-HASH");
  const parsed = await executeParse(inputBytes, request, requestPath, signal, options);
  const validatedParsed = ParsedDocumentSchema.parse(parsed);
  const result: ParserResult = {
    version: PARSER_PROTOCOL_VERSION, ok: true, requestId: request.requestId, requestSha256: sha256(requestBytes),
    inputSha256: request.inputSha256, normalizedContentHash: sha256(validatedParsed.text), parsedSha256: sha256(canonicalParsed(validatedParsed)), parsed: validatedParsed,
  };
  const resultBytes = Buffer.from(JSON.stringify(result));
  if (resultBytes.length > executionConfig(options).maxResultBytes) throw new Error("OCC-AI-PARSER-RESULT-BOUNDS");
  await atomicWrite(outputPath, resultBytes, { owner: "worker" });
  await rm(requestPath, { force: true });
}

async function processClaim(path: string, roots: { input: string; requests: string; output: string }, options: ExecutionOptions, signal: AbortSignal): Promise<void> {
  let request: ParserRequest | undefined;
  let requestBytes: Buffer | undefined;
  try { ({ request, bytes: requestBytes } = await readRequest(path)); } catch { await rm(path, { force: true }); return; }
  try {
    await processParserRequest(path, roots.input, roots.output, options, signal);
  } catch (error) {
    const code = error instanceof Error && /^OCC-AI-(?:DOCUMENT|PARSER)-[A-Z0-9-]+$/u.test(error.message) ? error.message : "OCC-AI-PARSER-FAILED";
    const result: ParserResult = { version: PARSER_PROTOCOL_VERSION, ok: false, requestId: request.requestId, requestSha256: sha256(requestBytes), inputSha256: request.inputSha256, errorCode: code };
    await atomicWrite(child(roots.output, request.outputFile), Buffer.from(JSON.stringify(result)), { owner: "worker" }).catch(() => undefined);
    await rm(path, { force: true });
  }
}

export async function runParserWorker(options: WorkerOptions, signal: AbortSignal): Promise<void> {
  const [input, requests, output] = await Promise.all([root(options.inputRoot), root(options.requestRoot), root(options.outputRoot)]);
  if (new Set([input, requests, output]).size !== 3) throw new Error("OCC-AI-PARSER-CONFIG");
  await removeStaleAtomicTemps(output, "worker-output");
  const pollMs = options.pollMs ?? 25;
  if (pollMs < 5 || pollMs > 1_000) throw new Error("OCC-AI-PARSER-CONFIG");
  let lastHeartbeat = 0;
  while (!signal.aborted) {
    if (Date.now() - lastHeartbeat >= 1_000) {
      await atomicWrite(child(output, ".parser-heartbeat.json"), Buffer.from(JSON.stringify({ version: 1, at: Date.now() })), { owner: "worker" });
      lastHeartbeat = Date.now();
    }
    const entries = (await readdir(requests, { withFileTypes: true })).filter((entry) => entry.isFile() && /^(?:[a-f0-9-]{36})\.(?:request|processing)\.json$/u.test(entry.name)).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (signal.aborted) break;
      let claim = child(requests, entry.name);
      if (entry.name.endsWith(".request.json")) {
        const processing = child(requests, entry.name.replace(/\.request\.json$/u, ".processing.json"));
        try { await rename(claim, processing); claim = processing; } catch { continue; }
      }
      await processClaim(claim, { input, requests, output }, options, signal);
    }
    if (!signal.aborted) await waitForParserPoll(pollMs, signal);
  }
}

type PollDelay = (milliseconds: number, value: undefined, options: { signal: AbortSignal }) => Promise<unknown>;
export async function waitForParserPoll(pollMs: number, signal: AbortSignal, timer: PollDelay = delay): Promise<void> {
  try { await timer(pollMs, undefined, { signal }); }
  catch (error) { if (!(error instanceof Error) || error.name !== "AbortError") throw error; }
}

async function main(): Promise<void> {
  const inputRoot = process.env.PARSER_INPUT_ROOT; const requestRoot = process.env.PARSER_REQUEST_ROOT; const outputRoot = process.env.PARSER_OUTPUT_ROOT;
  if (!inputRoot || !requestRoot || !outputRoot) throw new Error("OCC-AI-PARSER-CONFIG");
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort()); process.once("SIGINT", () => controller.abort());
  const taskUrl = process.env.PARSER_TASK_URL === undefined ? undefined : new URL(process.env.PARSER_TASK_URL);
  const testHooks = Object.fromEntries([
    ["hang", process.env.PARSER_TEST_HANG_SHA256],
    ["memory", process.env.PARSER_TEST_MEMORY_SHA256],
    ["output", process.env.PARSER_TEST_OUTPUT_SHA256],
  ].filter((entry): entry is [TestHook, string] => typeof entry[1] === "string"));
  await runParserWorker({
    inputRoot, requestRoot, outputRoot, ...(taskUrl === undefined ? {} : { taskUrl }),
    pollMs: Number(process.env.PARSER_POLL_MS ?? 25),
    executionTimeoutMs: Number(process.env.PARSER_EXECUTION_TIMEOUT_MS ?? 60_000),
    maxResultBytes: Number(process.env.PARSER_MAX_RESULT_BYTES ?? MAX_PARSER_RESULT_BYTES),
    resourceLimits: { maxOldGenerationSizeMb: Number(process.env.PARSER_MAX_OLD_GENERATION_MB ?? 256), maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    testHooks,
  }, controller.signal);
}

if (process.env.PARSER_WORKER_RUN === "true" || (process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replaceAll("\\", "/")}`).href)) {
  main().catch((error) => { console.error(error instanceof Error && /^OCC-AI-PARSER-[A-Z0-9-]+$/u.test(error.message) ? error.message : "OCC-AI-PARSER-FAILED"); process.exitCode = 1; });
}
