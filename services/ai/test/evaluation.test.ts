import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { EvaluationRunner } from "../src/evaluation/evaluation-runner.js";
import { PostgresEvaluationRepository } from "../src/evaluation/evaluation-repository.js";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const cases = Array.from({ length: 20 }, (_, index) => ({
  id: `00000000-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
  caseKey: `case-${String(index + 1).padStart(2, "0")}`,
  input: { query: `query-${index}` },
  expectedProperties: { relevantChunkIds: [`chunk-${index}`], adversarial: index === 19, expectedOutcome: index === 19 ? "SAFE_REFUSAL" : "ANSWER" },
}));

function dependencies(overrides: Record<string, unknown> = {}) {
  const repository = {
    begin: vi.fn().mockResolvedValue("evaluation-id"),
    recordCase: vi.fn(),
    finalize: vi.fn().mockResolvedValue("PASS"),
  };
  return {
    repository,
    dataset: { id: "dataset-id", contentHash: digest("dataset"), status: "PUBLISHED", cases },
    candidateSpaceId: "candidate-id", expectedActiveSpaceId: "active-id", corpusManifestDigest: digest("manifest"),
    evaluate: vi.fn(async (item: typeof cases[number]) => ({ supportedCitations: 19, totalCitations: 20, relevantFoundAt10: item.expectedProperties.relevantChunkIds.length, relevantExpected: item.expectedProperties.relevantChunkIds.length, leakageCount: 0, outcome: item.expectedProperties.expectedOutcome, evidenceHash: digest(item.caseKey) })),
    ...overrides,
  };
}

describe("fixed quality gate runner", () => {
  it("evaluates exactly every published immutable case and persists evidence before finalizing", async () => {
    const input = dependencies();
    const result = await new EvaluationRunner(input as never).run(new AbortController().signal);
    expect(result).toEqual({ evaluationId: "evaluation-id", decision: "PASS" });
    expect(input.repository.begin).toHaveBeenCalledWith(expect.objectContaining({ evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u) }), expect.any(AbortSignal));
    expect(input.repository.recordCase).toHaveBeenCalledTimes(20);
    expect(input.repository.recordCase.mock.calls[0]?.[0]).toMatchObject({ citationNumerator: 19, citationDenominator: 20, recallNumerator: 1, recallDenominator: 1, leakageCount: 0, expectedOutcomeHash: digest("ANSWER"), actualOutcomeHash: digest("ANSWER"), outcomeStatus: "MATCH", evidenceHash: digest("case-01") });
    expect(input.repository.finalize).toHaveBeenCalledAfter(input.repository.recordCase);
  });

  it.each([
    ["fewer than 20 cases", { dataset: { id: "dataset-id", contentHash: digest("dataset"), status: "PUBLISHED", cases: cases.slice(0, 19) } }],
    ["draft dataset", { dataset: { id: "dataset-id", contentHash: digest("dataset"), status: "DRAFT", cases } }],
    ["duplicate case", { dataset: { id: "dataset-id", contentHash: digest("dataset"), status: "PUBLISHED", cases: [...cases.slice(0, 19), cases[0]] } }],
  ])("rejects %s before beginning", async (_name, override) => {
    const input = dependencies(override);
    await expect(new EvaluationRunner(input as never).run(new AbortController().signal)).rejects.toThrow("OCC-AI-EVALUATION-DATASET");
    expect(input.repository.begin).not.toHaveBeenCalled();
  });

  it.each([
    ["empty citation denominator", { supportedCitations: 0, totalCitations: 0, relevantFoundAt10: 1, relevantExpected: 1, leakageCount: 0, outcome: "ANSWER", evidenceHash: digest("x") }],
    ["empty recall denominator", { supportedCitations: 1, totalCitations: 1, relevantFoundAt10: 0, relevantExpected: 0, leakageCount: 0, outcome: "ANSWER", evidenceHash: digest("x") }],
    ["extra citations", { supportedCitations: 2, totalCitations: 1, relevantFoundAt10: 1, relevantExpected: 1, leakageCount: 0, outcome: "ANSWER", evidenceHash: digest("x") }],
  ])("rejects %s without finalization", async (name, evidence) => {
    const input = dependencies({ evaluate: vi.fn(async (item: typeof cases[number]) => name === "wrong adversarial outcome" && !item.expectedProperties.adversarial ? { ...evidence, outcome: item.expectedProperties.expectedOutcome } : evidence) });
    await expect(new EvaluationRunner(input as never).run(new AbortController().signal)).rejects.toThrow(/^OCC-AI-EVALUATION-/u);
    expect(input.repository.finalize).not.toHaveBeenCalled();
  });

  it("persists adversarial outcome mismatch as immutable FAIL evidence", async () => {
    const input = dependencies({ evaluate: vi.fn(async (item: typeof cases[number]) => ({ supportedCitations: 1, totalCitations: 1, relevantFoundAt10: 1, relevantExpected: 1, leakageCount: 0, outcome: item.expectedProperties.adversarial ? "ANSWER" : item.expectedProperties.expectedOutcome, evidenceHash: digest(item.caseKey) })), repository: { begin: vi.fn().mockResolvedValue("evaluation-id"), recordCase: vi.fn(), finalize: vi.fn().mockResolvedValue("FAIL") } });
    await expect(new EvaluationRunner(input as never).run(new AbortController().signal)).resolves.toEqual({ evaluationId: "evaluation-id", decision: "FAIL" });
    expect(input.repository.recordCase).toHaveBeenCalledWith(expect.objectContaining({ caseId: cases[19]!.id, outcomeStatus: "MISMATCH", expectedOutcomeHash: digest("SAFE_REFUSAL"), actualOutcomeHash: digest("ANSWER") }), expect.any(AbortSignal));
  });

  it("does not expose caller-controlled quality thresholds", () => {
    const input = dependencies({ thresholds: { coverage: 0, leakage: 999, citationPrecision: 0, recallAt10: 0 } });
    expect(() => new EvaluationRunner(input as never)).toThrow("OCC-AI-EVALUATION-CONFIG");
  });
});

describe("V015 evaluation repository", () => {
  it("uses only begin, case, and finalize security-definer functions with complete bindings", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "evaluation-id" }] })
      .mockResolvedValueOnce({ rows: [{ id: cases[0]!.id }] })
      .mockResolvedValueOnce({ rows: [{ decision: "PASS" }] });
    const repository = new PostgresEvaluationRepository({ query } as never);
    await repository.begin({ evaluationId: "evaluation-id", datasetVersionId: "dataset-id", candidateSpaceId: "candidate-id", corpusManifestDigest: digest("manifest"), expectedActiveSpaceId: "active-id", evidenceHash: digest("begin") }, new AbortController().signal);
    await repository.recordCase({ evaluationId: "evaluation-id", caseId: cases[0]!.id, citationNumerator: 19, citationDenominator: 20, recallNumerator: 9, recallDenominator: 10, leakageCount: 0, expectedOutcomeHash: digest("ANSWER"), actualOutcomeHash: digest("ANSWER"), outcomeStatus: "MATCH", evidenceHash: digest("case") }, new AbortController().signal);
    await expect(repository.finalize("evaluation-id", new AbortController().signal)).resolves.toBe("PASS");
    const sql = query.mock.calls.map((call) => call[0]).join("\n");
    expect(sql).toContain("ai.begin_embedding_space_gate");
    expect(sql).toContain("ai.record_embedding_gate_case");
    expect(sql).toContain("ai.finalize_embedding_space_gate");
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/iu);
  });

  it("maps manifest races and database details to stable codes", async () => {
    const repository = new PostgresEvaluationRepository({ query: vi.fn().mockRejectedValue(Object.assign(new Error("stale corpus manifest with secret"), { code: "55000" })) } as never);
    await expect(repository.finalize("evaluation-id", new AbortController().signal)).rejects.toThrow("OCC-AI-EVALUATION-STALE");
  });
});
