import { describe, expect, it } from "vitest";

import {
  aiGuidanceRequestedEventSchema,
  aiOperationDeadLetteredEventSchema,
  aiRecommendationProposedEventSchema,
  capabilityProbeSchema,
  capabilitySnapshotSchema,
  dataClassificationSchema,
  generatedRecommendationSchema,
  guidanceRequestSchema,
  guidanceStatusSchema,
  knowledgeActivationRequestSchema,
  knowledgeGateResultSchema,
  knowledgeIngestionJobSchema,
  knowledgeIngestionRequestedEventSchema,
  knowledgeRollbackRequestSchema,
  knowledgeUploadMetadataSchema,
  providerConfigSchema,
  providerProfileSchema,
  recommendationDetailSchema,
  recommendationListSchema,
  recommendationReviewRequestSchema,
  serviceGrantClaimSchema,
  serviceGrantExchangeSchema,
  serviceRecommendationSubmissionSchema,
} from "../src/index.js";

const UUID = "550e8400-e29b-41d4-a716-446655440000";
const UUID_2 = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const UUID_3 = "123e4567-e89b-42d3-a456-426614174000";
const SHA = "a".repeat(64);
const NOW = "2026-08-01T10:30:00Z";

const recommendation = {
  generatedContent: true,
  summary: "Inspect the evidence requirement.",
  steps: [{ text: "Compare the submitted trace.", citationRanks: [1] }],
  confidence: 0.8,
  citations: [{ rank: 1, retrievalHitId: UUID, excerptHash: SHA }],
} as const;

const envelope = {
  id: UUID,
  customerInstanceId: UUID_2,
  aggregateId: UUID_3,
  aggregateVersion: 1,
  occurredAt: NOW,
  correlationId: UUID,
};

describe("governed AI provider contracts", () => {
  it("fixes the classification order", () => {
    expect(dataClassificationSchema.options).toEqual([
      "PUBLIC",
      "INTERNAL",
      "CONFIDENTIAL",
      "RESTRICTED",
    ]);
  });

  it("accepts an exact HTTPS provider origin and normalized API prefix", () => {
    const provider = {
      id: UUID,
      name: "Internal OpenAI-compatible provider",
      origin: "https://models.example.test:8443",
      apiPrefix: "/v1",
      approvedPrivateCidrs: ["10.40.0.0/16", "fd00:40::/48"],
      credentialFile: "/run/secrets/ai-provider-key",
      enabled: true,
      version: 0,
    };
    expect(providerConfigSchema.parse(provider)).toEqual(provider);

    for (const invalid of [
      { ...provider, origin: "http://models.example.test" },
      { ...provider, origin: "https://user@models.example.test" },
      { ...provider, origin: "https://models.example.test/v1" },
      { ...provider, origin: "https://models.example.test?key=value" },
      { ...provider, apiPrefix: "v1" },
      { ...provider, apiPrefix: "/v1/" },
      { ...provider, apiPrefix: "/v1/../admin" },
      { ...provider, approvedPrivateCidrs: ["10.0.0.0/99"] },
      { ...provider, approvedPrivateCidrs: ["fd00:::1/48"] },
      { ...provider, apiKey: "must-not-appear" },
    ]) expect(() => providerConfigSchema.parse(invalid)).toThrow();
  });

  it("bounds profiles, accounting, limits, and normalized probes", () => {
    const capabilities = {
      chat: true,
      embeddings: true,
      structuredOutput: true,
      embeddingDimensions: 1536,
      maxInputTokens: 128_000,
      maxOutputTokens: 4096,
      probedAt: NOW,
      snapshotHash: SHA,
    };
    expect(capabilitySnapshotSchema.parse(capabilities)).toEqual(capabilities);
    expect(capabilityProbeSchema.parse({
      id: UUID_3,
      providerId: UUID,
      status: "SUCCEEDED",
      requestedAt: NOW,
      completedAt: NOW,
      snapshot: capabilities,
    })).toBeDefined();
    expect(providerProfileSchema.parse({
      id: UUID_2,
      providerId: UUID,
      name: "Participant guidance",
      purpose: "CHAT",
      model: "governed-chat-1",
      maxClassification: "CONFIDENTIAL",
      requiredCapabilities: {
        structuredOutput: true,
        embeddingDimensions: 1536,
      },
      timeouts: { connectMs: 1000, totalMs: 30_000 },
      rateLimit: { requestsPerMinute: 60, tokensPerMinute: 200_000, maxConcurrency: 4 },
      cost: {
        currency: "USD",
        inputMicrosPerMillionTokens: 2_000_000,
        outputMicrosPerMillionTokens: 8_000_000,
      },
      capabilitySnapshot: capabilities,
      enabled: true,
      version: 3,
    })).toBeDefined();
    expect(() => capabilitySnapshotSchema.parse({ ...capabilities, maxOutputTokens: 0 })).toThrow();
    expect(() => capabilitySnapshotSchema.parse({ ...capabilities, models: ["raw-provider-shape"] })).toThrow();
  });
});

describe("governed knowledge contracts", () => {
  it.each([
    ["TEXT", "text/plain", "guide.txt"],
    ["MARKDOWN", "text/markdown", "guide.md"],
    ["PDF", "application/pdf", "guide.pdf"],
    ["DOCX", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "guide.docx"],
    ["XLSX", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "guide.xlsx"],
  ])("accepts bounded %s upload metadata", (format, mediaType, fileName) => {
    expect(knowledgeUploadMetadataSchema.parse({
      fileName,
      mediaType,
      format,
      title: "Evidence guide",
      classification: "INTERNAL",
      sizeBytes: 1024,
      contentHash: SHA,
    })).toBeDefined();
  });

  it("defines resumable ingestion stages and terminal state", () => {
    const job = {
      id: UUID,
      documentVersionId: UUID_2,
      stage: "QUALITY_GATE",
      status: "RUNNING",
      progressPercent: 95,
      attempt: 2,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(knowledgeIngestionJobSchema.parse(job)).toEqual(job);
    expect(() => knowledgeIngestionJobSchema.parse({ ...job, progressPercent: 101 })).toThrow();
    expect(() => knowledgeIngestionJobSchema.parse({ ...job, providerBody: "secret" })).toThrow();
  });

  it("captures complete gate evidence and versioned activation or rollback", () => {
    expect(knowledgeGateResultSchema.parse({
      id: UUID,
      embeddingSpaceId: UUID_2,
      corpusManifestHash: SHA,
      metrics: {
        coverage: 1,
        unauthorizedHits: 0,
        citationPrecision: 0.97,
        recallAt10: 0.9,
      },
      decision: "PASS",
      evaluatedAt: NOW,
    })).toBeDefined();
    expect(knowledgeActivationRequestSchema.parse({ gateResultId: UUID, expectedVersion: 4 })).toBeDefined();
    expect(knowledgeRollbackRequestSchema.parse({ targetVersionId: UUID_2, expectedVersion: 5 })).toBeDefined();
    expect(() => knowledgeActivationRequestSchema.parse({ gateResultId: UUID, expectedVersion: -1 })).toThrow();
  });
});

describe("governed guidance and recommendation contracts", () => {
  it("bounds guidance requests and status", () => {
    expect(guidanceRequestSchema.parse({
      targetEntityId: UUID,
      taskId: UUID_2,
      providerProfileId: UUID_3,
      expectedTargetVersion: 7,
    })).toBeDefined();
    expect(guidanceStatusSchema.parse({
      operationId: UUID,
      status: "RUNNING",
      requestedAt: NOW,
      updatedAt: NOW,
    })).toBeDefined();
  });

  it("accepts only fully cited generated recommendations", () => {
    expect(generatedRecommendationSchema.parse(recommendation)).toEqual(recommendation);
    for (const invalid of [
      { ...recommendation, generatedContent: false },
      { ...recommendation, summary: "" },
      { ...recommendation, steps: [] },
      { ...recommendation, citations: [] },
      { ...recommendation, extra: true },
      { ...recommendation, steps: [{ text: "Uncited", citationRanks: [] }] },
      { ...recommendation, steps: [{ text: "Missing", citationRanks: [2] }] },
      { ...recommendation, steps: [{ text: "Duplicate", citationRanks: [1, 1] }] },
      { ...recommendation, citations: [...recommendation.citations, recommendation.citations[0]] },
      { ...recommendation, citations: [{ rank: 1, retrievalHitId: UUID, excerptHash: "bad" }] },
    ]) expect(() => generatedRecommendationSchema.parse(invalid)).toThrow();
  });

  it("defines service grant exchange without allowing secrets into requests or events", () => {
    expect(serviceGrantClaimSchema.parse({ operationId: UUID })).toEqual({ operationId: UUID });
    expect(serviceGrantExchangeSchema.parse({ operationId: UUID, grantToken: "a.b.c" })).toBeDefined();
    expect(() => serviceGrantClaimSchema.parse({ operationId: UUID, grantToken: "a.b.c" })).toThrow();
    expect(() => serviceGrantExchangeSchema.parse({ operationId: UUID, grantToken: "x".repeat(8193) })).toThrow();
  });

  it("defines list, detail, stale state, and versioned human review", () => {
    const item = {
      id: UUID,
      targetEntityId: UUID_2,
      status: "PROPOSED",
      summary: recommendation.summary,
      confidence: recommendation.confidence,
      staleReasons: ["DOCUMENT_VERSION_CHANGED"],
      version: 2,
      createdAt: NOW,
    } as const;
    expect(recommendationListSchema.parse({ items: [item], nextCursor: "next-page" })).toBeDefined();
    expect(recommendationDetailSchema.parse({ ...item, output: recommendation })).toBeDefined();
    expect(recommendationReviewRequestSchema.parse({ decision: "ACCEPTED", expectedVersion: 2 })).toBeDefined();
    expect(() => recommendationReviewRequestSchema.parse({ decision: "PROPOSED", expectedVersion: 2 })).toThrow();
    expect(() => recommendationListSchema.parse({ items: [], nextCursor: "x".repeat(1025) })).toThrow();
  });

  it("bounds service recommendation submissions", () => {
    expect(serviceRecommendationSubmissionSchema.parse({
      operationId: UUID,
      runId: UUID_2,
      targetEntityId: UUID_3,
      expectedTargetVersion: 7,
      output: recommendation,
    })).toBeDefined();
  });
});

describe("governed AI event contracts", () => {
  it("parses exact versioned payloads through the event envelope", () => {
    expect(knowledgeIngestionRequestedEventSchema.parse({
      ...envelope,
      type: "knowledge.ingestion-requested.v1",
      schemaVersion: 1,
      aggregateType: "KnowledgeDocument",
      payload: { operationId: UUID, ingestionJobId: UUID_2, documentVersionId: UUID_3 },
    })).toBeDefined();
    expect(aiGuidanceRequestedEventSchema.parse({
      ...envelope,
      type: "ai.guidance-requested.v1",
      schemaVersion: 1,
      aggregateType: "AiGuidanceOperation",
      payload: { operationId: UUID, routing: { routingKey: "participant-guidance", attempt: 0 } },
    })).toBeDefined();
    expect(aiRecommendationProposedEventSchema.parse({
      ...envelope,
      type: "ai.recommendation-proposed.v1",
      schemaVersion: 1,
      aggregateType: "AiRecommendation",
      payload: { operationId: UUID, recommendationId: UUID_2, runId: UUID_3 },
    })).toBeDefined();
    expect(aiOperationDeadLetteredEventSchema.parse({
      ...envelope,
      type: "ai.operation-dead-lettered.v1",
      schemaVersion: 1,
      aggregateType: "AiGuidanceOperation",
      payload: {
        operationId: UUID,
        failedEventId: UUID_2,
        failedEventType: "ai.guidance-requested.v1",
        attempts: 5,
        errorCode: "OCC-AI-PROVIDER-TIMEOUT",
      },
    })).toBeDefined();
  });

  it("rejects wrong versions and every secret or generated content field", () => {
    const event = {
      ...envelope,
      type: "ai.guidance-requested.v1",
      schemaVersion: 1,
      aggregateType: "AiGuidanceOperation",
      payload: { operationId: UUID, routing: { routingKey: "guidance", attempt: 0 } },
    };
    for (const invalid of [
      { ...event, schemaVersion: 2 },
      { ...event, type: "ai.guidance-requested.v2" },
      { ...event, payload: { ...event.payload, grantToken: "a.b.c" } },
      { ...event, payload: { ...event.payload, content: "prompt" } },
      { ...event, payload: { ...event.payload, providerCredential: "secret" } },
      { ...event, payload: { ...event.payload, routing: { ...event.payload.routing, token: "secret" } } },
    ]) expect(() => aiGuidanceRequestedEventSchema.parse(invalid)).toThrow();
  });
});
