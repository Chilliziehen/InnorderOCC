import { createHash } from "node:crypto";

import { guidanceOutputSchema } from "@innorder/contracts";

import { containsProhibitedIntent } from "../retrieval/hybrid-retriever.js";
import type { PersistedRetrievalHit } from "../retrieval/postgres-retrieval-repository.js";

const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export function validateGuidanceOutput(output: unknown, evidence: Readonly<{
  runId: string;
  traceId: string;
  hits: readonly PersistedRetrievalHit[];
}>): ReturnType<typeof guidanceOutputSchema.parse> {
  const parsed = guidanceOutputSchema.safeParse(output);
  if (!parsed.success) throw new Error("OCC-AI-OUTPUT-MALFORMED");
  const hitsByRank = new Map(evidence.hits.map((hit) => [hit.rank, hit]));
  for (const citation of parsed.data.citations) {
    const hit = hitsByRank.get(citation.rank);
    if (hit === undefined || hit.traceId !== evidence.traceId || hit.retrievalHitId !== citation.retrievalHitId ||
      hit.excerptHash !== citation.excerptHash || digest(hit.content) !== citation.excerptHash) {
      throw new Error("OCC-AI-CITATION-INVALID");
    }
    if (hit.injectionDetected) throw new Error("OCC-AI-PROMPT-INJECTION");
  }
  if (containsProhibitedIntent(parsed.data.summary) || parsed.data.steps.some(({ text }) => containsProhibitedIntent(text))) {
    throw new Error("OCC-AI-PROMPT-INJECTION");
  }
  return parsed.data;
}
