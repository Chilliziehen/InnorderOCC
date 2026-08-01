import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { SaxesParser } from "saxes";

import { decodeDocumentText, DocumentPolicyError, inspectDocument, type DocumentInput } from "./document-policy.js";

export type ParsedRegion = Readonly<{ start: number; end: number; source: string; injectionMarked: boolean }>;
export type ParsedDocument = Readonly<{ text: string; regions: readonly ParsedRegion[]; parserVersion: string }>;
export const PARSER_VERSION = "governed-parser-v1";
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

function normalize(value: string): string {
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").normalize("NFC").trim();
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
  return { text, regions, parserVersion: PARSER_VERSION };
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
