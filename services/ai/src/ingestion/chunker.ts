import { createHash } from "node:crypto";

import { detectInstructionSpans, type ParsedDocument } from "./parser.js";

export const CHUNKER_VERSION = "governed-chunker-v3";
export type Chunk = Readonly<{ ordinal: number; content: string; contentHash: string; tokenCount: number; metadata: Readonly<Record<string, unknown>> }>;
type Piece = Readonly<{ start: number; end: number }>;
type MarkedSpan = { start: number; end: number; relativeStart: number; relativeEnd: number; category: string; source: string };

function tokens(value: string): number { return Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 4)); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function hardEnd(text: string, start: number, maxTokens: number): number {
  const maxBytes = maxTokens * 4;
  let bytes = 0;
  let end = start;
  for (const character of text.slice(start)) {
    const width = Buffer.byteLength(character, "utf8");
    if (end > start && bytes + width > maxBytes) break;
    bytes += width;
    end += character.length;
    if (bytes >= maxBytes) break;
  }
  return Math.max(start + 1, end);
}

function lastBoundary(text: string, start: number, limit: number): number {
  const candidate = text.slice(start, limit);
  const boundaries: number[][] = [[], [], []];
  for (const match of candidate.matchAll(/\n{2,}/gu)) boundaries[0]!.push(match.index + match[0].length);
  for (const match of candidate.matchAll(/[.!?。！？](?:\s+|$)/gu)) boundaries[1]!.push(match.index + match[0].length);
  for (const match of candidate.matchAll(/\s+/gu)) boundaries[2]!.push(match.index + match[0].length);
  for (const values of boundaries) {
    const boundary = values.at(-1);
    if (boundary !== undefined && boundary > 0) return start + boundary;
  }
  return limit;
}

function overlapStart(text: string, start: number, end: number, overlapTokens: number): number {
  if (overlapTokens === 0) return end;
  const maxBytes = overlapTokens * 4;
  let bytes = 0;
  let cursor = end;
  const characters = [...text.slice(start, end)];
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]!;
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > maxBytes) break;
    bytes += width;
    cursor -= character.length;
  }
  return cursor > start ? cursor : end;
}

function pieces(text: string, maxTokens: number, overlapTokens: number): Piece[] {
  const result: Piece[] = [];
  let start = 0;
  while (start < text.length) {
    const limit = hardEnd(text, start, maxTokens);
    const end = limit >= text.length ? text.length : lastBoundary(text, start, limit);
    if (end <= start) throw new Error("OCC-AI-CHUNKER-BOUND");
    if (text.slice(start, end).trim().length > 0) result.push({ start, end });
    if (end >= text.length) break;
    start = overlapStart(text, start, end, overlapTokens);
  }
  return result;
}

function mergeSpans(spans: MarkedSpan[]): MarkedSpan[] {
  const merged: MarkedSpan[] = [];
  for (const category of [...new Set(spans.map((span) => span.category))].sort()) {
    const categorySpans = spans.filter((span) => span.category === category).sort((left, right) => left.start - right.start || left.end - right.end || left.source.localeCompare(right.source));
    for (const span of categorySpans) {
      const previous = merged.at(-1);
      if (previous !== undefined && previous.category === category && span.start <= previous.end) {
        previous.end = Math.max(previous.end, span.end);
        previous.relativeEnd = Math.max(previous.relativeEnd, span.relativeEnd);
        if (span.source.localeCompare(previous.source) < 0) previous.source = span.source;
      } else merged.push({ ...span });
    }
  }
  return merged.sort((left, right) => left.start - right.start || left.end - right.end || left.category.localeCompare(right.category) || left.source.localeCompare(right.source));
}

export function chunkDocument(document: ParsedDocument, options: Readonly<{ maxTokens?: number; overlapTokens?: number }> = {}): Chunk[] {
  const maxTokens = options.maxTokens ?? 384;
  const overlapTokens = options.overlapTokens ?? 32;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 16 || maxTokens > 1024 || !Number.isSafeInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= maxTokens / 2) throw new Error("OCC-AI-CHUNKER-CONFIG");
  return pieces(document.text, maxTokens, overlapTokens).map((piece, ordinal) => {
    const content = document.text.slice(piece.start, piece.end);
    if (!content || tokens(content) > maxTokens) throw new Error("OCC-AI-CHUNKER-BOUND");
    const sourceRegions = document.regions.filter((region) => !region.injectionMarked && region.end > piece.start && region.start < piece.end);
    const parserMarked = document.regions.filter((region) => region.injectionMarked && region.end > piece.start && region.start < piece.end)
      .flatMap((region) => (region.categories ?? ["instruction_like"]).map((category) => {
        const start = Math.max(region.start, piece.start); const end = Math.min(region.end, piece.end);
        return { start, end, relativeStart: start - piece.start, relativeEnd: end - piece.start, category, source: region.source };
      }));
    const fallbackMarked = detectInstructionSpans(content).map((span) => ({ start: piece.start + span.start, end: piece.start + span.end, relativeStart: span.start, relativeEnd: span.end, category: span.category, source: sourceRegions[0]?.source ?? "document" }));
    const markedSpans = mergeSpans([...parserMarked, ...fallbackMarked]);
    return { ordinal, content, contentHash: hash(content), tokenCount: tokens(content), metadata: { chunkerVersion: CHUNKER_VERSION, provenance: [...new Set(sourceRegions.map((region) => region.source))], injectionMarked: markedSpans.length > 0, markedSpans } };
  });
}
