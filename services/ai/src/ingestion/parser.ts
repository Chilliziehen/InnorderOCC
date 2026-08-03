import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { SaxesParser } from "saxes";

import { decodeDocumentText, DocumentPolicyError, inspectDocument, type DocumentInput } from "./document-policy.js";

export type ParsedRegion = Readonly<{ start: number; end: number; source: string; injectionMarked: boolean; categories?: readonly string[] | undefined }>;
export type ParsedDocument = Readonly<{ text: string; regions: readonly ParsedRegion[]; parserVersion: string }>;
export const PARSER_VERSION = "governed-parser-v1";
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

function normalize(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").normalize("NFC").trim();
}

const INSTRUCTION_PATTERNS: readonly Readonly<{ category: string; pattern: RegExp }>[] = [
  { category: "prompt_override", pattern: /(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|prompt)\s+(?:instructions?|prompts?)/giu },
  { category: "prompt_override", pattern: /(?:忽略|覆盖).{0,12}(?:之前|系统|提示|指令)/gu },
  { category: "credential_exfiltration", pattern: /(?:reveal|show|leak|print|expose).{0,24}(?:credentials?|secrets?|passwords?|tokens?|api\s+keys?)/giu },
  { category: "credential_exfiltration", pattern: /(?:泄露|显示|输出).{0,12}(?:密码|凭据|密钥|令牌)/gu },
  { category: "authorization_change", pattern: /(?:bypass|change|remove|elevate).{0,24}(?:authori[sz]ation|permissions?|gates?|polic(?:y|ies))/giu },
  { category: "authorization_change", pattern: /(?:绕过|更改|提升).{0,12}(?:授权|权限|门禁|策略)/gu },
  { category: "control_disable", pattern: /(?:disable|turn\s+off|remove).{0,24}(?:controls?|security|guards?|filters?)/giu },
  { category: "control_disable", pattern: /(?:禁用|关闭|移除).{0,12}(?:安全|控制|防护|过滤)/gu },
  { category: "tool_execution", pattern: /(?:execute|run|invoke|call).{0,20}(?:tools?|commands?|shell|code)/giu },
  { category: "tool_execution", pattern: /(?:执行|调用|运行).{0,12}(?:工具|命令|代码)/gu },
];

export function detectInstructionSpans(value: string): readonly Readonly<{ start: number; end: number; category: string }>[] {
  const persisted = value.normalize("NFC");
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  const startOffsets: number[] = [];
  const endOffsets: number[] = [];
  let normalized = "";
  for (const { segment, index } of segmenter.segment(persisted)) {
    const compatible = segment.normalize("NFKC");
    const normalizedStart = normalized.length;
    normalized += compatible;
    for (let offset = 0; offset < compatible.length; offset += 1) startOffsets[normalizedStart + offset] = index;
    for (let offset = 1; offset <= compatible.length; offset += 1) endOffsets[normalizedStart + offset] = index + segment.length;
  }
  const spans: { start: number; end: number; category: string }[] = [];
  for (const { category, pattern } of INSTRUCTION_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of normalized.matchAll(pattern)) {
      if (match.index !== undefined && match[0].length > 0) {
        const start = startOffsets[match.index];
        const end = endOffsets[match.index + match[0].length];
        if (start !== undefined && end !== undefined && end > start) spans.push({ start, end, category });
      }
    }
  }
  const sorted = spans.sort((left, right) => left.start - right.start || left.end - right.end || left.category.localeCompare(right.category));
  const merged: { start: number; end: number; category: string }[] = [];
  for (const span of sorted) {
    const previous = merged.at(-1);
    if (previous !== undefined && previous.category === span.category && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

function result(values: readonly Readonly<{ text: string; source: string }>[]): ParsedDocument {
  let text = "";
  const regions: ParsedRegion[] = [];
  for (const value of values) {
    const normalized = normalize(value.text);
    if (!normalized) continue;
    if (text) text += "\n";
    const start = text.length;
    text += normalized;
    regions.push({ start, end: text.length, source: value.source, injectionMarked: false });
  }
  if (!text || Buffer.byteLength(text) > MAX_OUTPUT_BYTES) throw new DocumentPolicyError("OCC-AI-DOCUMENT-NO-TEXT");
  const injectionRegions = detectInstructionSpans(text).map((span) => {
    const source = regions.find((region) => region.end > span.start && region.start < span.end)?.source ?? "document";
    return { start: span.start, end: span.end, source, injectionMarked: true, categories: [span.category] } satisfies ParsedRegion;
  });
  return { text, regions: [...regions, ...injectionRegions], parserVersion: PARSER_VERSION };
}

function parseXml(xml: string, handlers: Readonly<{ open(name: string, attributes: Readonly<Record<string, string>>): void; text(value: string): void; close(name: string): void }>): void {
  const parser = new SaxesParser({ xmlns: false, fragment: false });
  parser.on("opentag", (tag) => handlers.open(tag.name, Object.fromEntries(Object.entries(tag.attributes).map(([key, value]) => [key, String(value)]))));
  parser.on("text", handlers.text);
  parser.on("closetag", (tag) => handlers.close(tag.name));
  parser.on("error", () => { throw new Error("OCC-AI-DOCUMENT-XML"); });
  parser.write(xml).close();
}

function docx(parts: Readonly<Record<string, Uint8Array>>): ParsedDocument {
  const xml = decodeDocumentText(parts["word/document.xml"] ?? new Uint8Array());
  const paragraphs: string[] = [];
  let paragraph: string[] | undefined;
  parseXml(xml, {
    open: (name) => { if (name.endsWith(":p") || name === "p") paragraph = []; if ((name.endsWith(":tab") || name === "tab") && paragraph) paragraph.push("\t"); },
    text: (value) => paragraph?.push(value),
    close: (name) => { if ((name.endsWith(":p") || name === "p") && paragraph) { paragraphs.push(paragraph.join("")); paragraph = undefined; } },
  });
  return result(paragraphs.map((value, index) => ({ text: value, source: `paragraph:${index + 1}` })));
}

function relationshipMap(xml: string): Map<string, string> {
  const map = new Map<string, string>();
  parseXml(xml, { open: (name, attributes) => { if (name.endsWith("Relationship")) map.set(attributes.Id ?? "", attributes.Target ?? ""); }, text: () => undefined, close: () => undefined });
  return map;
}

function xlsx(parts: Readonly<Record<string, Uint8Array>>): ParsedDocument {
  const shared: string[] = [];
  const sharedPart = parts["xl/sharedStrings.xml"];
  if (sharedPart !== undefined) {
    let current: string[] | undefined;
    parseXml(decodeDocumentText(sharedPart), { open: (name) => { if (name === "si") current = []; }, text: (value) => current?.push(value), close: (name) => { if (name === "si" && current) { shared.push(current.join("")); current = undefined; } } });
  }
  const relationships = relationshipMap(decodeDocumentText(parts["xl/_rels/workbook.xml.rels"] ?? new Uint8Array()));
  const sheets: { name: string; target: string }[] = [];
  parseXml(decodeDocumentText(parts["xl/workbook.xml"] ?? new Uint8Array()), {
    open: (name, attributes) => { if (name === "sheet") sheets.push({ name: attributes.name ?? "", target: relationships.get(attributes["r:id"] ?? "") ?? "" }); }, text: () => undefined, close: () => undefined,
  });
  const rows: { text: string; source: string }[] = [];
  for (const sheet of sheets) {
    const path = sheet.target.startsWith("/") ? sheet.target.slice(1) : `xl/${sheet.target.replace(/^\.\//u, "")}`;
    const xml = decodeDocumentText(parts[path] ?? new Uint8Array());
    let row = "";
    let cells: string[] | undefined;
    let cellType = "";
    let cell = "";
    let capture = false;
    parseXml(xml, {
      open: (name, attributes) => {
        if (name === "row") { row = attributes.r ?? String(rows.length + 1); cells = []; }
        if (name === "c") { cellType = attributes.t ?? ""; cell = ""; }
        if (name === "v" || name === "t") capture = true;
      },
      text: (value) => { if (capture) cell += value; },
      close: (name) => {
        if (name === "v" || name === "t") capture = false;
        if (name === "c" && cells) cells.push(cellType === "s" ? shared[Number(cell)] ?? "" : cell);
        if (name === "row" && cells) { rows.push({ text: cells.join("\t"), source: `sheet:${sheet.name}!row:${row}` }); cells = undefined; }
      },
    });
  }
  return result(rows);
}

async function pdf(bytes: Uint8Array): Promise<ParsedDocument> {
  const loading = getDocument({ data: Uint8Array.from(bytes), disableFontFace: true, useSystemFonts: false, useWorkerFetch: false, disableRange: true, disableStream: true, disableAutoFetch: true, verbosity: 0 });
  try {
    const document = await loading.promise;
    const [attachments, fieldObjects, actions, openAction] = await Promise.all([
      document.getAttachments(), document.getFieldObjects(), document.getJSActions(), document.getOpenAction(),
    ]);
    if (attachments !== null || fieldObjects !== null || actions !== null || openAction !== null) throw new Error("OCC-AI-DOCUMENT-ACTIVE-CONTENT");
    const pages: { text: string; source: string }[] = [];
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await document.getPage(index);
      const annotations = await page.getAnnotations({ intent: "any" });
      const pageActions: object | null = await page.getJSActions();
      if (annotations.length > 0 || (pageActions !== null && Object.keys(pageActions).length > 0)) throw new Error("OCC-AI-DOCUMENT-ACTIVE-CONTENT");
      const content = await page.getTextContent({ disableNormalization: false });
      const pageText = content.items.map((item) => "str" in item ? item.str : "").join(" ");
      if (!normalize(pageText)) throw new Error("OCC-AI-DOCUMENT-NO-TEXT");
      pages.push({ text: pageText, source: `page:${index}` });
      page.cleanup();
    }
    return result(pages);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("OCC-AI-DOCUMENT-")) throw error;
    throw new Error("OCC-AI-DOCUMENT-MALFORMED");
  } finally {
    await loading.destroy();
  }
}

export async function parseDocument(input: DocumentInput): Promise<ParsedDocument> {
  const inspected = inspectDocument(input);
  if (inspected.format === "text" || inspected.format === "markdown") return result([{ text: decodeDocumentText(inspected.bytes), source: "section:1" }]);
  if (inspected.format === "pdf") return pdf(inspected.bytes);
  if (inspected.format === "docx") return docx(inspected.parts!);
  return xlsx(inspected.parts!);
}
