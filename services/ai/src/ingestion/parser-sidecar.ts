import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import type { ParsedDocument } from "./parser.js";
import {
  canonicalParsed, MAX_PARSER_INPUT_BYTES, MAX_PARSER_RESULT_BYTES, PARSER_PROTOCOL_VERSION,
  ParserResultSchema, sha256, type ParserRequest,
} from "./parser-protocol.js";

type Options = Readonly<{ inputRoot: string; requestRoot: string; outputRoot: string; timeoutMs?: number; pollMs?: number; requestId?: () => string }>;

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  try { const directory = await open(dirname(path), constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); } } catch { /* Directory fsync is unavailable on Windows. */ }
}

async function safeRoot(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("OCC-AI-PARSER-CONFIG");
  return realpath(path);
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal.aborted) return reject(new Error("OCC-AI-PARSER-CANCELLED"));
    const timer = setTimeout(resolvePromise, milliseconds); timer.unref();
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("OCC-AI-PARSER-CANCELLED")); }, { once: true });
  });
}

export class ParserSidecarClient {
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly requestId: () => string;
  constructor(private readonly options: Options) {
    const roots = [options.inputRoot, options.requestRoot, options.outputRoot].map((path) => resolve(path));
    if (new Set(roots).size !== 3) throw new Error("OCC-AI-PARSER-CONFIG");
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.pollMs = options.pollMs ?? 25;
    this.requestId = options.requestId ?? randomUUID;
    if (this.timeoutMs < 1 || this.timeoutMs > 60_000 || this.pollMs < 5 || this.pollMs > 1_000) throw new Error("OCC-AI-PARSER-CONFIG");
  }

  async parse(input: Readonly<{ bytes: Uint8Array; fileName: string; mimeType: string }>, signal: AbortSignal): Promise<ParsedDocument> {
    if (input.bytes.length < 1 || input.bytes.length > MAX_PARSER_INPUT_BYTES) throw new Error("OCC-AI-PARSER-INPUT");
    const [inputRoot, requestRoot, outputRoot] = await Promise.all([safeRoot(this.options.inputRoot), safeRoot(this.options.requestRoot), safeRoot(this.options.outputRoot)]);
    const requestId = this.requestId();
    const inputSha256 = sha256(input.bytes);
    const inputFile = `${requestId}.${inputSha256}.bin`;
    const outputFile = `${requestId}.result.json`;
    const requestFile = `${requestId}.request.json`;
    const request: ParserRequest = { version: PARSER_PROTOCOL_VERSION, requestId, inputFile, inputSha256, fileName: input.fileName, mimeType: input.mimeType, outputFile };
    const requestBytes = Buffer.from(JSON.stringify(request));
    const requestHash = sha256(requestBytes);
    const inputPath = resolve(inputRoot, inputFile); const requestPath = resolve(requestRoot, requestFile); const outputPath = resolve(outputRoot, outputFile);
    const processingPath = resolve(requestRoot, `${requestId}.processing.json`);
    if ([inputPath, requestPath, outputPath, processingPath].some((path) => basename(path).includes(".."))) throw new Error("OCC-AI-PARSER-CONFIG");
    let ownsInput = false;
    let ownsRequest = false;
    try {
      for (const path of [inputPath, requestPath, processingPath, outputPath]) {
        try { await lstat(path); throw new Error("OCC-AI-PARSER-DUPLICATE"); }
        catch (error) {
          if (error instanceof Error && error.message === "OCC-AI-PARSER-DUPLICATE") throw error;
          if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw new Error("OCC-AI-PARSER-CONFIG");
        }
      }
      await atomicWrite(inputPath, input.bytes);
      ownsInput = true;
      await atomicWrite(requestPath, requestBytes);
      ownsRequest = true;
      const deadline = Date.now() + this.timeoutMs;
      while (true) {
        if (signal.aborted) throw new Error("OCC-AI-PARSER-CANCELLED");
        if (Date.now() >= deadline) throw new Error("OCC-AI-PARSER-TIMEOUT");
        try {
          const metadata = await stat(outputPath);
          if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_PARSER_RESULT_BYTES) throw new Error("OCC-AI-PARSER-RESULT-BOUNDS");
          const raw = await readFile(outputPath);
          const result = ParserResultSchema.parse(JSON.parse(raw.toString("utf8")));
          if (result.requestId !== requestId || result.requestSha256 !== requestHash || result.inputSha256 !== inputSha256) throw new Error("OCC-AI-PARSER-RESULT-HASH");
          if (!result.ok) throw new Error(result.errorCode);
          if (result.normalizedContentHash !== sha256(result.parsed.text) || result.parsedSha256 !== sha256(canonicalParsed(result.parsed))) throw new Error("OCC-AI-PARSER-RESULT-HASH");
          return result.parsed;
        } catch (error) {
          if (error instanceof Error && (error.message.startsWith("OCC-AI-") || error.name === "ZodError")) throw error.name === "ZodError" ? new Error("OCC-AI-PARSER-RESULT-SCHEMA") : error;
          await sleep(Math.min(this.pollMs, Math.max(1, deadline - Date.now())), signal);
        }
      }
    } finally {
      const ownedPaths = [...(ownsInput ? [inputPath] : []), ...(ownsRequest ? [requestPath, processingPath, outputPath] : [])];
      await Promise.all(ownedPaths.map((path) => rm(path, { force: true }).catch(() => undefined)));
    }
  }
}
