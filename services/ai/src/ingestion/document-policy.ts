import { unzipSync } from "fflate";

export type DocumentFormat = "text" | "markdown" | "pdf" | "docx" | "xlsx";

export class DocumentPolicyError extends Error {
  constructor(readonly code: string) { super(code); }
}

export type DocumentInput = Readonly<{
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  maxSourceBytes?: number;
  maxEntries?: number;
  maxExpandedBytes?: number;
}>;

export type InspectedDocument = Readonly<{
  format: DocumentFormat;
  bytes: Uint8Array;
  parts?: Readonly<Record<string, Uint8Array>>;
}>;

const FORMATS = {
  ".txt": ["text/plain", "text"],
  ".md": ["text/markdown", "markdown"],
  ".pdf": ["application/pdf", "pdf"],
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ".xlsx": ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
} as const;

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
const ACTIVE_PDF = /\/(?:JavaScript|JS|OpenAction|AA|Launch|RichMedia|EmbeddedFiles|FileAttachment|AcroForm|XFA|Encrypt)\b/u;
const ACTIVE_PART = /(?:^|\/)(?:vbaProject\.bin|embeddings?(?:\/|$)|activeX(?:\/|$)|externalLinks?(?:\/|$)|oleObject)/iu;
const ACTIVE_TEXT = /<\s*(?:script|iframe|object|embed|form)\b|(?:https?|ftp|file|javascript):(?:\/\/)?|\\\\[^\\]/iu;
const ALLOWED_DOCX_PART = /^(?:\[Content_Types\]\.xml|_rels\/\.rels|docProps\/(?:core|app)\.xml|word\/(?:document|styles|numbering|settings|fontTable|webSettings)\.xml|word\/_rels\/document\.xml\.rels|word\/theme\/theme\d+\.xml)$/u;
const ALLOWED_XLSX_PART = /^(?:\[Content_Types\]\.xml|_rels\/\.rels|docProps\/(?:core|app)\.xml|xl\/(?:workbook|sharedStrings|styles|calcChain)\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/worksheets\/sheet\d+\.xml|xl\/theme\/theme\d+\.xml)$/u;

function fail(suffix: string): never { throw new DocumentPolicyError(`OCC-AI-DOCUMENT-${suffix}`); }

function strictUtf8(bytes: Uint8Array): string {
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (value.includes("\0") || value.startsWith("\uFEFF")) fail("MALFORMED");
    return value;
  } catch (error) {
    if (error instanceof DocumentPolicyError) throw error;
    return fail("MALFORMED");
  }
}

function extension(fileName: string): keyof typeof FORMATS {
  if (!/^[^/\\\0]{1,255}$/u.test(fileName)) fail("TYPE-MISMATCH");
  const dot = fileName.lastIndexOf(".");
  const ext = fileName.slice(dot).toLowerCase();
  if (!(ext in FORMATS)) fail("UNSUPPORTED");
  return ext as keyof typeof FORMATS;
}

function readUInt32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function inspectZip(bytes: Uint8Array, maxEntries: number, maxExpandedBytes: number): Record<string, Uint8Array> {
  if (bytes.length < 4 || readUInt32(bytes, 0) !== 0x04034b50) fail("TYPE-MISMATCH");
  if (bytes.length < 22) fail("ARCHIVE-MALFORMED");
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (readUInt32(bytes, offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) fail("ARCHIVE-MALFORMED");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const commentLength = view.getUint16(eocd + 20, true);
  if (commentLength !== 0 || eocd + 22 !== bytes.length) fail("ACTIVE-CONTENT");
  const entryCount = view.getUint16(eocd + 10, true);
  if (entryCount > maxEntries) fail("ARCHIVE-BOUNDS");
  let offset = view.getUint32(eocd + 16, true);
  let expanded = 0;
  const names = new Set<string>();
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || readUInt32(bytes, offset) !== 0x02014b50) fail("ARCHIVE-MALFORMED");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const entryCommentLength = view.getUint16(offset + 32, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const name = strictUtf8(bytes.subarray(offset + 46, offset + 46 + nameLength)).replaceAll("\\", "/");
    if ((flags & 1) !== 0) fail("ENCRYPTED");
    if (method !== 0 && method !== 8) fail("COMPRESSION");
    if (size > 0 && (compressedSize === 0 || size / compressedSize > 100)) fail("ARCHIVE-BOUNDS");
    if (!name || name.startsWith("/") || name.split("/").some((part) => part === ".." || part === ".") || names.has(name)) fail("ARCHIVE-PATH");
    if (((externalAttributes >>> 16) & 0xf000) === 0xa000) fail("ARCHIVE-PATH");
    names.add(name);
    expanded += size;
    if (!Number.isSafeInteger(expanded) || expanded > maxExpandedBytes) fail("ARCHIVE-BOUNDS");
    offset += 46 + nameLength + extraLength + entryCommentLength;
  }
  if (offset !== eocd) fail("ARCHIVE-MALFORMED");
  let parts: Record<string, Uint8Array>;
  try { parts = unzipSync(bytes); } catch { return fail("ARCHIVE-MALFORMED"); }
  if (Object.keys(parts).length !== entryCount) fail("ARCHIVE-MALFORMED");
  return parts;
}

function inspectOpenXml(format: "docx" | "xlsx", parts: Record<string, Uint8Array>): void {
  const contentTypes = parts["[Content_Types].xml"] === undefined ? "" : strictUtf8(parts["[Content_Types].xml"]);
  const expected = format === "docx" ? "wordprocessingml.document.main+xml" : "spreadsheetml.sheet.main+xml";
  if (!contentTypes.includes(expected)) fail("TYPE-MISMATCH");
  for (const [name, bytes] of Object.entries(parts)) {
    if (!(format === "docx" ? ALLOWED_DOCX_PART : ALLOWED_XLSX_PART).test(name)) fail("ACTIVE-CONTENT");
    if (ACTIVE_PART.test(name)) fail("ACTIVE-CONTENT");
    if (name.endsWith(".rels")) {
      const relationships = strictUtf8(bytes);
      if (/TargetMode\s*=\s*["']External["']/iu.test(relationships) || /Target\s*=\s*["'](?:https?:|file:|ftp:|\\\\|\/\/)/iu.test(relationships) || /Target\s*=\s*["'][^"']*(?:^|\/)\.\.(?:\/|["'])/imu.test(relationships)) fail("EXTERNAL-REFERENCE");
    }
    if (name.endsWith(".xml")) {
      const xml = strictUtf8(bytes);
      if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) fail("ACTIVE-CONTENT");
      if (format === "xlsx" && /<(?:[A-Za-z0-9_]+:)?f(?:\s|>)/u.test(xml)) fail("FORMULA");
    }
  }
}

export function inspectDocument(input: DocumentInput): InspectedDocument {
  const maxSourceBytes = input.maxSourceBytes ?? MAX_SOURCE_BYTES;
  const maxEntries = input.maxEntries ?? MAX_ENTRIES;
  const maxExpandedBytes = input.maxExpandedBytes ?? MAX_EXPANDED_BYTES;
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1 || input.bytes.length < 1 || input.bytes.length > maxSourceBytes) fail("SOURCE-BOUNDS");
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES || !Number.isSafeInteger(maxExpandedBytes) || maxExpandedBytes < 1 || maxExpandedBytes > MAX_EXPANDED_BYTES) fail("ARCHIVE-BOUNDS");
  const ext = extension(input.fileName);
  const [mimeType, format] = FORMATS[ext];
  if (input.mimeType !== mimeType) fail("TYPE-MISMATCH");
  if (format === "text" || format === "markdown") {
    if (input.bytes[0] === 0x25 && input.bytes[1] === 0x50 || input.bytes[0] === 0x50 && input.bytes[1] === 0x4b) fail("TYPE-MISMATCH");
    const source = strictUtf8(input.bytes);
    if (ACTIVE_TEXT.test(source)) fail("ACTIVE-CONTENT");
    return { format, bytes: input.bytes };
  }
  if (format === "pdf") {
    const source = Buffer.from(input.bytes).toString("latin1");
    if (!source.startsWith("%PDF-") || ACTIVE_PDF.test(source)) fail(source.includes("/Encrypt") ? "ENCRYPTED" : "ACTIVE-CONTENT");
    const eof = source.lastIndexOf("%%EOF");
    if (eof < 0 || source.slice(eof + 5).trim().length > 0) fail("ACTIVE-CONTENT");
    return { format, bytes: input.bytes };
  }
  const parts = inspectZip(input.bytes, maxEntries, maxExpandedBytes);
  inspectOpenXml(format, parts);
  return { format, bytes: input.bytes, parts };
}

export function decodeDocumentText(bytes: Uint8Array): string { return strictUtf8(bytes); }
