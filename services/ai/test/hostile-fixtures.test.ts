import { readFile } from "node:fs/promises";

import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { inspectDocument, type DocumentInput } from "../src/ingestion/document-policy.js";

type Scenario = Readonly<{ id: string; format: string; control: string; layer: "policy" | "malware" | "sidecar"; expected?: string }>;
const fixture = (name: string) => new URL(`./fixtures/ingestion/sources/${name}`, import.meta.url);
const bytes = (value: string): Uint8Array => Buffer.from(value, "utf8");

function archive(parts: Record<string, string | Uint8Array>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(parts).map(([name, value]) => [name, typeof value === "string" ? bytes(value) : value])));
}

function docx(documentXml: string, extra: Record<string, string | Uint8Array> = {}): Uint8Array {
  return archive({
    "[Content_Types].xml": `<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<Relationships><Relationship Id="rId1" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": documentXml,
    ...extra,
  });
}

function xlsx(sheetXml: string, extra: Record<string, string | Uint8Array> = {}): Uint8Array {
  return archive({
    "[Content_Types].xml": `<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
    "_rels/.rels": `<Relationships><Relationship Id="rId1" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
    "xl/worksheets/sheet1.xml": sheetXml,
    ...extra,
  });
}

function pdf(label = "fixture"): Uint8Array {
  return bytes(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n% ${label}\n%%EOF\n`);
}

function mutateCentral(input: Uint8Array, entryName: string, mutate: (copy: Buffer, offset: number) => void): Uint8Array {
  const copy = Buffer.from(input);
  for (let offset = 0; offset + 46 <= copy.length; offset += 1) {
    if (copy.readUInt32LE(offset) !== 0x02014b50) continue;
    const length = copy.readUInt16LE(offset + 28);
    if (copy.subarray(offset + 46, offset + 46 + length).toString("utf8") === entryName) { mutate(copy, offset); return copy; }
  }
  throw new Error(`missing fixture entry ${entryName}`);
}

async function inputFor(scenario: Scenario): Promise<DocumentInput> {
  const cleanDocx = (await readFile(fixture("docx-document.xml"), "utf8")).trim();
  const cleanXlsx = (await readFile(fixture("xlsx-sheet.xml"), "utf8")).trim();
  const base = scenario.format === "docx" ? docx(cleanDocx) : scenario.format === "xlsx" ? xlsx(cleanXlsx) : new Uint8Array();
  const common = scenario.format === "docx"
    ? { fileName: "fixture.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }
    : { fileName: "fixture.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  switch (scenario.id) {
    case "text-polyglot-pdf": return { fileName: "fixture.txt", mimeType: "text/plain", bytes: pdf() };
    case "markdown-polyglot-zip": return { fileName: "fixture.md", mimeType: "text/markdown", bytes: archive({ "safe.txt": "safe" }) };
    case "pdf-trailing-data": return { fileName: "fixture.pdf", mimeType: "application/pdf", bytes: Buffer.concat([pdf(), bytes("trailing")]) };
    case "docx-trailing-data":
    case "xlsx-trailing-data": return { ...common, bytes: Buffer.concat([base, bytes("trailing")]) };
    case "docx-archive-traversal": return { ...common, bytes: archive({ "[Content_Types].xml": "wordprocessingml.document.main+xml", "word/document.xml": cleanDocx, "../evil.xml": "safe" }) };
    case "xlsx-archive-traversal": return { ...common, bytes: archive({ "[Content_Types].xml": "spreadsheetml.sheet.main+xml", "xl/workbook.xml": "<workbook/>", "../evil.xml": "safe" }) };
    case "docx-archive-duplicate":
    case "xlsx-archive-duplicate": {
      const first = scenario.format === "docx" ? "word/aa.xml" : "xl/aaaa.xml";
      const second = scenario.format === "docx" ? "word/bb.xml" : "xl/bbbb.xml";
      const duplicateBase = archive({ "[Content_Types].xml": scenario.format === "docx" ? "wordprocessingml.document.main+xml" : "spreadsheetml.sheet.main+xml", [first]: "a", [second]: "b" });
      return { ...common, bytes: mutateCentral(duplicateBase, second, (copy, offset) => copy.write(first, offset + 46, "utf8")) };
    }
    case "docx-archive-compression-bomb": return { ...common, bytes: docx(cleanDocx.replace("Clean DOCX fixture", "a".repeat(20_000))) };
    case "xlsx-archive-compression-bomb": return { ...common, bytes: xlsx(cleanXlsx.replace("Clean XLSX fixture", "a".repeat(20_000))) };
    case "docx-archive-count":
    case "xlsx-archive-count": return { ...common, bytes: base, maxEntries: 2 };
    case "docx-archive-expanded":
    case "xlsx-archive-expanded": return { ...common, bytes: base, maxExpandedBytes: 100 };
    case "docx-archive-compression":
    case "xlsx-archive-compression": {
      const name = scenario.format === "docx" ? "word/document.xml" : "xl/workbook.xml";
      return { ...common, bytes: mutateCentral(base, name, (copy, offset) => copy.writeUInt16LE(99, offset + 10)) };
    }
    case "pdf-script": return { fileName: "fixture.pdf", mimeType: "application/pdf", bytes: bytes("%PDF-1.4\n/JavaScript 1 0 R\n%%EOF\n") };
    case "pdf-form": return { fileName: "fixture.pdf", mimeType: "application/pdf", bytes: bytes("%PDF-1.4\n/AcroForm 1 0 R\n%%EOF\n") };
    case "pdf-attachment": return { fileName: "fixture.pdf", mimeType: "application/pdf", bytes: bytes("%PDF-1.4\n/EmbeddedFiles 1 0 R\n%%EOF\n") };
    case "pdf-encryption": return { fileName: "fixture.pdf", mimeType: "application/pdf", bytes: bytes("%PDF-1.4\n/Encrypt 1 0 R\n%%EOF\n") };
    case "pdf-resource-bounds": return { fileName: "fixture.pdf", mimeType: "application/pdf", bytes: pdf(), maxSourceBytes: 4 };
    case "docx-macro": return { ...common, bytes: docx(cleanDocx, { "word/vbaProject.bin": "safe inert source" }) };
    case "docx-external": return { ...common, bytes: docx(cleanDocx, { "word/_rels/document.xml.rels": `<Relationships><Relationship Id="x" Target="https://example.invalid" TargetMode="External"/></Relationships>` }) };
    case "docx-embed": return { ...common, bytes: docx(cleanDocx, { "word/embeddings/object1.bin": "safe inert source" }) };
    case "xlsx-formula": return { ...common, bytes: xlsx(cleanXlsx.replace("<is><t>Clean XLSX fixture</t></is>", "<f>1+1</f><v>2</v>")) };
    case "xlsx-external": return { ...common, bytes: xlsx(cleanXlsx, { "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="https://example.invalid" TargetMode="External"/></Relationships>` }) };
    case "xlsx-embed": return { ...common, bytes: xlsx(cleanXlsx, { "xl/embeddings/object1.bin": "safe inert source" }) };
    case "text-malformed": return { fileName: "fixture.txt", mimeType: "text/plain", bytes: new Uint8Array([0xc3, 0x28]) };
    case "markdown-empty": return { fileName: "fixture.md", mimeType: "text/markdown", bytes: new Uint8Array() };
    case "pdf-malformed": return { fileName: "fixture.pdf", mimeType: "application/pdf", bytes: bytes("%PDF-1.4\n") };
    case "docx-malformed": return { ...common, bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]) };
    case "xlsx-empty": return { ...common, bytes: new Uint8Array() };
    default: throw new Error(`unimplemented policy fixture ${scenario.id}`);
  }
}

describe("hostile ingestion fixture manifest", async () => {
  const manifest = JSON.parse(await readFile(new URL("./fixtures/ingestion/manifest.json", import.meta.url), "utf8")) as { version: number; scenarios: Scenario[] };
  it("names every required format and control pair", () => {
    expect(manifest.version).toBe(1);
    expect(new Set(manifest.scenarios.map(({ id }) => id)).size).toBe(manifest.scenarios.length);
    for (const format of ["text", "markdown", "pdf", "docx", "xlsx"]) expect(manifest.scenarios.some((row) => row.id === `${format}-malware-before-parse`), `${format}-malware-before-parse`).toBe(true);
    for (const format of ["docx", "xlsx"]) for (const control of ["traversal", "duplicate", "compression-bomb", "count", "expanded", "compression"]) expect(manifest.scenarios.some((row) => row.id === `${format}-archive-${control}`), `${format}-archive-${control}`).toBe(true);
    for (const control of ["time", "output", "memory"]) expect(manifest.scenarios.some((row) => row.id === `parser-${control === "time" ? "execution" : control === "output" ? "result" : "worker"}-${control}`), `parser-${control}`).toBe(true);
  });

  for (const scenario of manifest.scenarios.filter(({ layer }) => layer === "policy")) {
    it(`${scenario.id} rejects with ${scenario.expected}`, async () => {
      const input = await inputFor(scenario);
      expect(() => inspectDocument(input), scenario.id).toThrow(scenario.expected);
    });
  }
});
