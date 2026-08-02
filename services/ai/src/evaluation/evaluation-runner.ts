import { createHash, randomUUID } from "node:crypto";

import type { BeginGate, GateCase } from "./evaluation-repository.js";

type EvaluationCase = Readonly<{ id: string; caseKey: string; input: Readonly<Record<string, unknown>>; expectedProperties: Readonly<{ relevantChunkIds: readonly string[]; adversarial?: boolean; expectedOutcome: string }> }>;
type Evidence = Readonly<{ supportedCitations: number; totalCitations: number; relevantFoundAt10: number; relevantExpected: number; leakageCount: number; outcome: string; evidenceHash: string }>;
type Dependencies = Readonly<{
  repository: { begin(input: BeginGate, signal: AbortSignal): Promise<string>; recordCase(input: GateCase, signal: AbortSignal): Promise<void>; finalize(id: string, signal: AbortSignal): Promise<"PASS" | "FAIL"> };
  dataset: Readonly<{ id: string; contentHash: string; status: string; cases: readonly EvaluationCase[] }>;
  candidateSpaceId: string; expectedActiveSpaceId: string; corpusManifestDigest: string;
  evaluate(item: EvaluationCase, signal: AbortSignal): Promise<Evidence>;
  evaluationId?: () => string;
}>;

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const HASH = /^[a-f0-9]{64}$/u;

export class EvaluationRunner {
  constructor(private readonly dependencies: Dependencies) {
    if (Object.keys(dependencies).some((key) => key === "thresholds")) throw new Error("OCC-AI-EVALUATION-CONFIG");
  }

  async run(signal: AbortSignal): Promise<Readonly<{ evaluationId: string; decision: "PASS" | "FAIL" }>> {
    const { dataset } = this.dependencies;
    if (dataset.status !== "PUBLISHED" || !HASH.test(dataset.contentHash) || dataset.cases.length < 20 || dataset.cases.length > 10_000 || new Set(dataset.cases.map(({ id }) => id)).size !== dataset.cases.length || new Set(dataset.cases.map(({ caseKey }) => caseKey)).size !== dataset.cases.length || dataset.cases.some((item) => Object.keys(item.input).length === 0 || Object.keys(item.expectedProperties).length === 0 || item.expectedProperties.relevantChunkIds.length === 0)) throw new Error("OCC-AI-EVALUATION-DATASET");
    const evaluationId = this.dependencies.evaluationId?.() ?? randomUUID();
    const evidenceHash = digest(JSON.stringify({ datasetContentHash: dataset.contentHash, corpusManifestDigest: this.dependencies.corpusManifestDigest, candidateSpaceId: this.dependencies.candidateSpaceId, expectedActiveSpaceId: this.dependencies.expectedActiveSpaceId }));
    const persistedEvaluationId = await this.dependencies.repository.begin({ evaluationId, datasetVersionId: dataset.id, candidateSpaceId: this.dependencies.candidateSpaceId, corpusManifestDigest: this.dependencies.corpusManifestDigest, expectedActiveSpaceId: this.dependencies.expectedActiveSpaceId, evidenceHash }, signal);
    for (const item of dataset.cases) {
      const evidence = await this.dependencies.evaluate(item, signal);
      if (!Number.isSafeInteger(evidence.supportedCitations) || !Number.isSafeInteger(evidence.totalCitations) || evidence.totalCitations < 1 || evidence.supportedCitations < 0 || evidence.supportedCitations > evidence.totalCitations || !Number.isSafeInteger(evidence.relevantFoundAt10) || !Number.isSafeInteger(evidence.relevantExpected) || evidence.relevantExpected < 1 || evidence.relevantFoundAt10 < 0 || evidence.relevantFoundAt10 > Math.min(10, evidence.relevantExpected) || !Number.isSafeInteger(evidence.leakageCount) || evidence.leakageCount < 0 || !evidence.outcome || evidence.outcome.length > 256 || !HASH.test(evidence.evidenceHash)) throw new Error("OCC-AI-EVALUATION-EVIDENCE");
      const expectedOutcomeHash = digest(item.expectedProperties.expectedOutcome);
      const actualOutcomeHash = digest(evidence.outcome);
      await this.dependencies.repository.recordCase({ evaluationId: persistedEvaluationId, caseId: item.id, citationNumerator: evidence.supportedCitations, citationDenominator: evidence.totalCitations, recallNumerator: evidence.relevantFoundAt10, recallDenominator: evidence.relevantExpected, leakageCount: evidence.leakageCount, expectedOutcomeHash, actualOutcomeHash, outcomeStatus: evidence.outcome === item.expectedProperties.expectedOutcome ? "MATCH" : "MISMATCH", evidenceHash: evidence.evidenceHash }, signal);
    }
    return { evaluationId: persistedEvaluationId, decision: await this.dependencies.repository.finalize(persistedEvaluationId, signal) };
  }
}
