import { createHash } from "node:crypto";

import { z } from "zod";

export const PARSER_PROTOCOL_VERSION = 1 as const;
export const MAX_PARSER_REQUEST_BYTES = 16 * 1024;
export const MAX_PARSER_RESULT_BYTES = 16 * 1024 * 1024;
export const MAX_PARSER_INPUT_BYTES = 32 * 1024 * 1024;

const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
const Region = z.object({
  start: z.number().int().nonnegative(), end: z.number().int().positive(), source: z.string().min(1).max(512),
  injectionMarked: z.boolean(), categories: z.array(z.string().min(1).max(64)).max(16).optional(),
}).strict().refine(({ start, end }) => end > start);
export const ParsedDocumentSchema = z.object({
  text: z.string().min(1).max(MAX_PARSER_RESULT_BYTES), regions: z.array(Region).min(1).max(100_000),
  parserVersion: z.string().regex(/^governed-parser-v\d+$/u),
}).strict();
export const ParserRequestSchema = z.object({
  version: z.literal(PARSER_PROTOCOL_VERSION), requestId: z.string().uuid(), inputFile: z.string().min(1).max(128),
  inputSha256: Digest, fileName: z.string().min(1).max(255), mimeType: z.string().min(1).max(255),
  outputFile: z.string().min(1).max(128),
}).strict().superRefine((value, context) => {
  if (value.inputFile !== `${value.requestId}.${value.inputSha256}.bin`) context.addIssue({ code: "custom", message: "input name is not hash bound" });
  if (value.outputFile !== `${value.requestId}.result.json`) context.addIssue({ code: "custom", message: "output name is not request bound" });
});
export const ParserResultSchema = z.discriminatedUnion("ok", [
  z.object({
    version: z.literal(PARSER_PROTOCOL_VERSION), ok: z.literal(true), requestId: z.string().uuid(), requestSha256: Digest,
    inputSha256: Digest, normalizedContentHash: Digest, parsedSha256: Digest, parsed: ParsedDocumentSchema,
  }).strict(),
  z.object({
    version: z.literal(PARSER_PROTOCOL_VERSION), ok: z.literal(false), requestId: z.string().uuid(), requestSha256: Digest,
    inputSha256: Digest, errorCode: z.string().regex(/^OCC-AI-(?:DOCUMENT|PARSER)-[A-Z0-9-]+$/u),
  }).strict(),
]);

export type ParserRequest = z.infer<typeof ParserRequestSchema>;
export type ParserResult = z.infer<typeof ParserResultSchema>;
export type ProtocolParsedDocument = z.infer<typeof ParsedDocumentSchema>;

export function sha256(value: Uint8Array | string): string { return createHash("sha256").update(value).digest("hex"); }
export function canonicalParsed(value: ProtocolParsedDocument): Buffer { return Buffer.from(JSON.stringify(value)); }
