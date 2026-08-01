import { createHash } from "node:crypto";

import type { ParsedDocument } from "./parser.js";

export const CHUNKER_VERSION = "governed-chunker-v1";
export type Chunk = Readonly<{ ordinal: number; content: string; contentHash: string; tokenCount: number; metadata: Readonly<Record<string, unknown>> }>;

function tokens(value: string): number { return Math.max(1, Math.ceil(Buffer.byteLength(value, "utf8") / 4)); }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function injection(value: string): boolean {
  const normalized = value.normalize("NFKC").toLowerCase().replace(/[\s_\-]+/gu, " ");
  return [
    /(?:ignore|disregard|override).{0,40}(?:previous|prior|system|prompt|instruction)/u,
    /(?:reveal|show|leak|print).{0,40}(?:credential|secret|password|token|api key)/u,
    /(?:bypass|change|remove).{0,40}(?:authori[sz]ation|gate|policy|permission)/u,
    /(?:disable|turn off).{0,40}(?:control|security|guard|filter)/u,
    /(?:execute|run|invoke|call).{0,30}(?:tool|command|shell|code)/u,
    /(?:忽略|覆盖).{0,20}(?:之前|系统|提示|指令)/u,
    /(?:泄露|显示|输出).{0,20}(?:密码|凭据|密钥|令牌)/u,
    /(?:绕过|更改).{0,20}(?:授权|权限|门禁|策略)/u,
    /(?:禁用|关闭).{0,20}(?:安全|控制|防护)/u,
    /(?:执行|调用).{0,20}(?:工具|命令|代码)/u,
  ].some((pattern) => pattern.test(normalized));
}

export function chunkDocument(document: ParsedDocument, options: Readonly<{ maxTokens?: number; overlapTokens?: number }> = {}): Chunk[] {
  const maxTokens = options.maxTokens ?? 384;
  const overlapTokens = options.overlapTokens ?? 32;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 16 || maxTokens > 1024 || !Number.isSafeInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= maxTokens / 2) throw new Error("OCC-AI-CHUNKER-CONFIG");
  const words = document.text.split(/(?<=\s)|(?=\s)/u).filter(Boolean);
  const spans: { content: string; start: number; end: number }[] = [];
  let index = 0;
  while (index < words.length) {
    let end = index;
    let content = "";
    while (end < words.length) {
      const candidate = content + words[end]!;
      if (content && tokens(candidate.trim()) > maxTokens) break;
      content = candidate;
      end += 1;
    }
    content = content.trim();
    if (content) {
      const start = document.text.indexOf(content, spans.at(-1)?.start ?? 0);
      spans.push({ content, start: Math.max(0, start), end: Math.max(0, start) + content.length });
    }
    if (end >= words.length) break;
    let overlapStart = end;
    let overlap = "";
    while (overlapStart > index && tokens((words[overlapStart - 1]! + overlap).trim()) <= overlapTokens) { overlapStart -= 1; overlap = words[overlapStart]! + overlap; }
    index = Math.max(index + 1, overlapStart);
  }
  return spans.map((span, ordinal) => {
    const provenance = [...new Set(document.regions.filter((region) => region.end > span.start && region.start < span.end).map((region) => region.source))];
    const injectionMarked = injection(span.content) || document.regions.some((region) => region.injectionMarked && region.end > span.start && region.start < span.end);
    return { ordinal, content: span.content, contentHash: hash(span.content), tokenCount: tokens(span.content), metadata: { chunkerVersion: CHUNKER_VERSION, provenance, injectionMarked } };
  });
}
