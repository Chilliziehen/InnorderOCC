import { createHash } from "node:crypto";

import { detectInstructionSpans, type ParsedDocument } from "./parser.js";

export const CHUNKER_VERSION = "governed-chunker-v2";
export type Chunk = Readonly<{ ordinal: number; content: string; contentHash: string; tokenCount: number; metadata: Readonly<Record<string, unknown>> }>;

function tokens(value: string): number { return Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 4)); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

type Piece = { content: string; start: number; end: number; paragraph: number };

function atomicUnits(value: string, absoluteStart: number, budget: number): Piece[] {
  const units: Piece[] = [];
  const sentences = value.match(/[^.!?。！？]+[.!?。！？]*(?:\s+|$)/gu) ?? [value];
  let sentenceCursor = 0;
  for (const sentence of sentences) {
    const sentenceStart = value.indexOf(sentence, sentenceCursor); sentenceCursor = sentenceStart + sentence.length;
    if (tokens(sentence.trim()) <= budget) { if (sentence.trim()) units.push({ content: sentence.trim(), start: absoluteStart + sentenceStart + sentence.indexOf(sentence.trim()), end: absoluteStart + sentenceStart + sentence.indexOf(sentence.trim()) + sentence.trim().length, paragraph: 0 }); continue; }
    const words = sentence.match(/\S+\s*/gu) ?? [sentence];
    let wordCursor = 0;
    for (const wordWithSpace of words) {
      const wordStart = sentence.indexOf(wordWithSpace, wordCursor); wordCursor = wordStart + wordWithSpace.length;
      const word = wordWithSpace.trim();
      if (!word) continue;
      if (tokens(word) <= budget) { units.push({ content: word, start: absoluteStart + sentenceStart + wordStart, end: absoluteStart + sentenceStart + wordStart + word.length, paragraph: 0 }); continue; }
      let chunk = ""; let chunkStart = 0;
      for (const character of word) {
        if (chunk && tokens(chunk + character) > budget) {
          units.push({ content: chunk, start: absoluteStart + sentenceStart + wordStart + chunkStart, end: absoluteStart + sentenceStart + wordStart + chunkStart + chunk.length, paragraph: 0 });
          chunkStart += chunk.length; chunk = "";
        }
        chunk += character;
      }
      if (chunk) units.push({ content: chunk, start: absoluteStart + sentenceStart + wordStart + chunkStart, end: absoluteStart + sentenceStart + wordStart + chunkStart + chunk.length, paragraph: 0 });
    }
  }
  return units;
}

function suffixWithin(value: string, budget: number): string {
  if (budget === 0) return "";
  let result = "";
  for (const character of [...value].reverse()) {
    if (tokens(character + result) > budget) break;
    result = character + result;
  }
  return result.trimStart();
}

function paragraphPieces(text: string, maxTokens: number, overlapTokens: number): Piece[] {
  const pieces: Piece[] = [];
  const paragraphs = text.split(/\n{2,}/u);
  let search = 0;
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const paragraphStart = text.indexOf(paragraph, search); search = paragraphStart + paragraph.length;
    const trimmed = paragraph.trim();
    if (!trimmed) return;
    const start = paragraphStart + paragraph.indexOf(trimmed);
    const budget = Math.max(1, maxTokens - overlapTokens);
    const units = atomicUnits(trimmed, start, budget);
    let current: Piece | undefined;
    for (const unit of units) {
      const separator = current === undefined ? "" : " ";
      const candidate = `${current?.content ?? ""}${separator}${unit.content}`;
      if (current !== undefined && tokens(candidate) > budget) { pieces.push({ ...current, paragraph: paragraphIndex }); current = undefined; }
      current = current === undefined ? { ...unit, paragraph: paragraphIndex } : { content: `${current.content} ${unit.content}`, start: current.start, end: unit.end, paragraph: paragraphIndex };
    }
    if (current !== undefined) pieces.push({ ...current, paragraph: paragraphIndex });
  });
  return pieces.map((piece, index) => {
    const previous = pieces[index - 1];
    if (previous === undefined || previous.paragraph !== piece.paragraph || overlapTokens === 0) return piece;
    let overlap = suffixWithin(previous.content, overlapTokens);
    while (overlap && tokens(`${overlap} ${piece.content}`) > maxTokens) overlap = [...overlap].slice(1).join("").trimStart();
    if (!overlap) return piece;
    const content = `${overlap} ${piece.content}`;
    return { content, start: Math.max(previous.start, previous.end - overlap.length), end: piece.end, paragraph: piece.paragraph };
  });
}

export function chunkDocument(document: ParsedDocument, options: Readonly<{ maxTokens?: number; overlapTokens?: number }> = {}): Chunk[] {
  const maxTokens = options.maxTokens ?? 384;
  const overlapTokens = options.overlapTokens ?? 32;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 16 || maxTokens > 1024 || !Number.isSafeInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= maxTokens / 2) throw new Error("OCC-AI-CHUNKER-CONFIG");
  const pieces = paragraphPieces(document.text, maxTokens, overlapTokens);
  return pieces.filter(({ content }) => content.length > 0).map((piece, ordinal) => {
    if (tokens(piece.content) > maxTokens) throw new Error("OCC-AI-CHUNKER-BOUND");
    const sourceRegions = document.regions.filter((region) => !region.injectionMarked && region.end > piece.start && region.start < piece.end);
    const parserMarked = document.regions.filter((region) => region.injectionMarked && region.end > piece.start && region.start < piece.end)
      .flatMap((region) => (region.categories ?? ["instruction_like"]).map((category) => ({ start: Math.max(region.start, piece.start), end: Math.min(region.end, piece.end), relativeStart: Math.max(0, region.start - piece.start), relativeEnd: Math.min(piece.content.length, region.end - piece.start), category, source: region.source })));
    const fallbackMarked = detectInstructionSpans(piece.content).map((span) => ({ start: piece.start + span.start, end: piece.start + span.end, relativeStart: span.start, relativeEnd: span.end, category: span.category, source: sourceRegions[0]?.source ?? "document" }));
    const markedSpans = [...parserMarked, ...fallbackMarked].filter((span, index, all) => all.findIndex((other) => other.start === span.start && other.end === span.end && other.category === span.category) === index);
    const provenance = [...new Set(sourceRegions.map((region) => region.source))];
    return { ordinal, content: piece.content, contentHash: hash(piece.content), tokenCount: tokens(piece.content), metadata: { chunkerVersion: CHUNKER_VERSION, provenance, injectionMarked: markedSpans.length > 0, markedSpans } };
  });
}
