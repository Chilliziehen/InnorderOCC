import { createHash } from "node:crypto";
import { open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { z } from "zod";

import { parseDocument } from "./parser.js";

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Envelope = z.object({
  version: z.literal(1), requestId: z.string().uuid(), inputFile: z.string().min(1).max(128), inputSha256: Digest,
  fileName: z.string().min(1).max(255), mimeType: z.string().min(1).max(255), outputFile: z.string().min(1).max(128),
}).strict();
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const hash = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

function child(root: string, name: string): string {
  if (basename(name) !== name || name.includes("\0")) throw new Error("OCC-AI-PARSER-ENVELOPE");
  const path = resolve(root, name);
  if (dirname(path) !== resolve(root)) throw new Error("OCC-AI-PARSER-ENVELOPE");
  return path;
}

export async function processParserRequest(requestPath: string, inputRoot: string, outputRoot: string): Promise<void> {
  if (dirname(resolve(requestPath)) !== resolve(inputRoot)) throw new Error("OCC-AI-PARSER-ENVELOPE");
  const requestStat = await stat(requestPath);
  if (!requestStat.isFile() || requestStat.size < 2 || requestStat.size > MAX_REQUEST_BYTES) throw new Error("OCC-AI-PARSER-ENVELOPE");
  let envelope: z.infer<typeof Envelope>;
  try { envelope = Envelope.parse(JSON.parse(await readFile(requestPath, "utf8"))); } catch { throw new Error("OCC-AI-PARSER-ENVELOPE"); }
  if (basename(requestPath) !== `${envelope.requestId}.request.json` || envelope.inputFile !== `${envelope.inputSha256}.bin` || envelope.outputFile !== `${envelope.requestId}.json`) throw new Error("OCC-AI-PARSER-ENVELOPE");
  const inputPath = child(inputRoot, envelope.inputFile);
  const outputPath = child(outputRoot, envelope.outputFile);
  const inputStat = await stat(inputPath);
  if (!inputStat.isFile() || inputStat.size < 1 || inputStat.size > MAX_INPUT_BYTES) throw new Error("OCC-AI-PARSER-INPUT");
  const handle = await open(inputPath, "r");
  let bytes: Buffer;
  try { bytes = await handle.readFile(); } finally { await handle.close(); }
  if (hash(bytes) !== envelope.inputSha256) throw new Error("OCC-AI-PARSER-HASH");
  const parsed = await parseDocument({ bytes, fileName: envelope.fileName, mimeType: envelope.mimeType, maxSourceBytes: MAX_INPUT_BYTES });
  const response = Buffer.from(JSON.stringify({ version: 1, requestId: envelope.requestId, inputSha256: envelope.inputSha256, resultSha256: createHash("sha256").update(parsed.text).digest("hex"), parsed }));
  const temporary = `${outputPath}.${process.pid}.tmp`;
  await writeFile(temporary, response, { flag: "wx", mode: 0o600 });
  await rename(temporary, outputPath);
  await rm(requestPath, { force: true });
}

async function main(): Promise<void> {
  const inputRoot = process.env.PARSER_INPUT_ROOT;
  const outputRoot = process.env.PARSER_OUTPUT_ROOT;
  const requestFile = process.env.PARSER_REQUEST_FILE;
  if (!inputRoot || !outputRoot || !requestFile) throw new Error("OCC-AI-PARSER-CONFIG");
  await processParserRequest(join(inputRoot, requestFile), inputRoot, outputRoot);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file:///${process.argv[1].replaceAll("\\", "/")}`).href) {
  main().catch(() => { process.exitCode = 1; });
}
