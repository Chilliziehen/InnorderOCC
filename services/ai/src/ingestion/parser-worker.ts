import { constants } from "node:fs";
import { open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { parseDocument } from "./parser.js";
import {
  canonicalParsed, MAX_PARSER_INPUT_BYTES, MAX_PARSER_REQUEST_BYTES, MAX_PARSER_RESULT_BYTES,
  PARSER_PROTOCOL_VERSION, ParsedDocumentSchema, ParserRequestSchema, sha256, type ParserRequest, type ParserResult,
} from "./parser-protocol.js";

type WorkerOptions = Readonly<{ inputRoot: string; requestRoot: string; outputRoot: string; pollMs?: number }>;

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  if (bytes.length > MAX_PARSER_RESULT_BYTES) throw new Error("OCC-AI-PARSER-RESULT-BOUNDS");
  const temporary = `${path}.${process.pid}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}

async function root(path: string): Promise<string> {
  const resolved = await realpath(path);
  const metadata = await stat(resolved);
  if (!metadata.isDirectory()) throw new Error("OCC-AI-PARSER-CONFIG");
  return resolved;
}

function child(rootPath: string, name: string): string {
  if (basename(name) !== name || name.includes("\0")) throw new Error("OCC-AI-PARSER-ENVELOPE");
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

export async function processParserRequest(requestPath: string, inputRoot: string, outputRoot: string): Promise<void> {
  const requestRoot = dirname(resolve(requestPath));
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
  const parsed = await parseDocument({ bytes: inputBytes, fileName: request.fileName, mimeType: request.mimeType, maxSourceBytes: MAX_PARSER_INPUT_BYTES });
  const validatedParsed = ParsedDocumentSchema.parse(parsed);
  const result: ParserResult = {
    version: PARSER_PROTOCOL_VERSION, ok: true, requestId: request.requestId, requestSha256: sha256(requestBytes),
    inputSha256: request.inputSha256, normalizedContentHash: sha256(validatedParsed.text), parsedSha256: sha256(canonicalParsed(validatedParsed)), parsed: validatedParsed,
  };
  await atomicWrite(outputPath, Buffer.from(JSON.stringify(result)));
  await rm(requestPath, { force: true });
  void requestRoot;
}

async function processClaim(path: string, roots: { input: string; requests: string; output: string }): Promise<void> {
  let request: ParserRequest | undefined;
  let requestBytes: Buffer | undefined;
  try { ({ request, bytes: requestBytes } = await readRequest(path)); } catch { await rm(path, { force: true }); return; }
  try {
    await processParserRequest(path, roots.input, roots.output);
  } catch (error) {
    const code = error instanceof Error && /^OCC-AI-(?:DOCUMENT|PARSER)-[A-Z0-9-]+$/u.test(error.message) ? error.message : "OCC-AI-PARSER-FAILED";
    const result: ParserResult = { version: PARSER_PROTOCOL_VERSION, ok: false, requestId: request.requestId, requestSha256: sha256(requestBytes), inputSha256: request.inputSha256, errorCode: code };
    await atomicWrite(child(roots.output, request.outputFile), Buffer.from(JSON.stringify(result))).catch(() => undefined);
    await rm(path, { force: true });
  }
}

export async function runParserWorker(options: WorkerOptions, signal: AbortSignal): Promise<void> {
  const [input, requests, output] = await Promise.all([root(options.inputRoot), root(options.requestRoot), root(options.outputRoot)]);
  if (new Set([input, requests, output]).size !== 3) throw new Error("OCC-AI-PARSER-CONFIG");
  const pollMs = options.pollMs ?? 25;
  if (pollMs < 5 || pollMs > 1_000) throw new Error("OCC-AI-PARSER-CONFIG");
  while (!signal.aborted) {
    const entries = (await readdir(requests, { withFileTypes: true })).filter((entry) => entry.isFile() && /^(?:[a-f0-9-]{36})\.(?:request|processing)\.json$/u.test(entry.name)).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (signal.aborted) break;
      let claim = child(requests, entry.name);
      if (entry.name.endsWith(".request.json")) {
        const processing = child(requests, entry.name.replace(/\.request\.json$/u, ".processing.json"));
        try { await rename(claim, processing); claim = processing; } catch { continue; }
      }
      await processClaim(claim, { input, requests, output });
    }
    if (!signal.aborted) await new Promise((resolvePromise) => { const timer = setTimeout(resolvePromise, pollMs); signal.addEventListener("abort", () => { clearTimeout(timer); resolvePromise(undefined); }, { once: true }); });
  }
}

async function main(): Promise<void> {
  const inputRoot = process.env.PARSER_INPUT_ROOT; const requestRoot = process.env.PARSER_REQUEST_ROOT; const outputRoot = process.env.PARSER_OUTPUT_ROOT;
  if (!inputRoot || !requestRoot || !outputRoot) throw new Error("OCC-AI-PARSER-CONFIG");
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort()); process.once("SIGINT", () => controller.abort());
  await runParserWorker({ inputRoot, requestRoot, outputRoot, pollMs: Number(process.env.PARSER_POLL_MS ?? 25) }, controller.signal);
}

if (process.env.PARSER_WORKER_RUN === "true" || (process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replaceAll("\\", "/")}`).href)) {
  main().catch((error) => { console.error(error instanceof Error && /^OCC-AI-PARSER-[A-Z0-9-]+$/u.test(error.message) ? error.message : "OCC-AI-PARSER-FAILED"); process.exitCode = 1; });
}
