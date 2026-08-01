import { describe, expect, it } from "vitest";

import {
  aiGuidanceRequestedEventSchema,
  aiOperationDeadLetteredEventSchema,
  aiRecommendationProposedEventSchema,
  approvedPrivateCidrSchema,
  aiGrantClaimsSchema,
  capabilityProbeSchema,
  capabilitySnapshotSchema,
  dataClassificationSchema,
  generatedRecommendationSchema,
  guidanceRequestSchema,
  guidanceStatusSchema,
  knowledgeActivationRequestSchema,
  knowledgeGateMetricsSchema,
  knowledgeGateResultSchema,
  knowledgeIngestionJobSchema,
  knowledgeIngestionRequestedEventSchema,
  knowledgeRollbackRequestSchema,
  knowledgeUploadMetadataSchema,
  providerConfigSchema,
  providerConfigUpdateSchema,
  providerProfileSchema,
  providerProfileUpdateSchema,
  recommendationDetailSchema,
  recommendationListSchema,
  recommendationReviewRequestSchema,
  serviceGrantClaimSchema,
  serviceGrantExchangeSchema,
  serviceIngestionOutcomeSchema,
  serviceOperationOutcomeSchema,
  serviceProviderProbeOutcomeSchema,
  serviceRecommendationSubmissionSchema,
} from "../src/index.js";

const UUID = "550e8400-e29b-41d4-a716-446655440000";
const UUID_2 = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const UUID_3 = "123e4567-e89b-42d3-a456-426614174000";
const SHA = "a".repeat(64);
const NOW = "2026-08-01T10:30:00Z";
const LATER = "2026-08-01T10:35:00Z";

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

  it.each([
    "10.0.0.0/8",
    "10.255.255.255/32",
    "172.16.0.0/12",
    "172.31.255.255/32",
    "192.168.0.0/16",
    "192.168.255.255/32",
    "fc00::/7",
    "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128",
  ])("accepts an approved private CIDR wholly inside its containing block: %s", (cidr) => {
    expect(approvedPrivateCidrSchema.parse(cidr)).toBe(cidr);
  });

  it.each([
    "0.0.0.0/0",
    "::/0",
    "8.8.8.0/24",
    "10.0.0.0/7",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "169.254.169.254/32",
    "172.16.0.0/11",
    "192.0.2.0/24",
    "192.168.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "fc00::/6",
    "fe80::/10",
    "::1/128",
    "2001:db8::/32",
  ])("rejects a public, special, or spillover CIDR: %s", (cidr) => {
    expect(() => approvedPrivateCidrSchema.parse(cidr)).toThrow();
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

  it("requires internally consistent capabilities, profiles, and probes", () => {
    const chatCapabilities = {
      chat: true,
      embeddings: false,
      structuredOutput: true,
      maxInputTokens: 128_000,
      maxOutputTokens: 4096,
      probedAt: NOW,
      snapshotHash: SHA,
    };
    const profile = {
      id: UUID_2,
      providerId: UUID,
      name: "Participant guidance",
      purpose: "CHAT",
      model: "governed-chat-1",
      maxClassification: "CONFIDENTIAL",
      requiredCapabilities: { structuredOutput: true },
      timeouts: { connectMs: 1000, totalMs: 30_000 },
      rateLimit: { requestsPerMinute: 60, tokensPerMinute: 200_000, maxConcurrency: 4 },
      cost: { currency: "USD", inputMicrosPerMillionTokens: 1, outputMicrosPerMillionTokens: 1 },
      capabilitySnapshot: chatCapabilities,
      enabled: true,
      version: 3,
    } as const;
    const probe = {
      id: UUID_3,
      providerId: UUID,
      status: "SUCCEEDED",
      requestedAt: NOW,
      completedAt: LATER,
      snapshot: chatCapabilities,
    } as const;

    expect(providerProfileSchema.parse(profile)).toBeDefined();
    expect(capabilityProbeSchema.parse(probe)).toBeDefined();
    expect(() => capabilitySnapshotSchema.parse({ ...chatCapabilities, embeddings: true })).toThrow();
    expect(() => providerProfileSchema.parse({ ...profile, purpose: "EMBEDDING" })).toThrow();
    expect(() => providerProfileSchema.parse({ ...profile, capabilitySnapshot: { ...chatCapabilities, chat: false } })).toThrow();
    expect(() => capabilityProbeSchema.parse({ ...probe, completedAt: undefined })).toThrow();
    expect(() => capabilityProbeSchema.parse({ ...probe, snapshot: undefined })).toThrow();
  });

  it("requires provider and profile updates to contain a change", () => {
    expect(() => providerConfigUpdateSchema.parse({ expectedVersion: 2 })).toThrow();
    expect(() => providerProfileUpdateSchema.parse({ expectedVersion: 2 })).toThrow();
    expect(() => providerProfileUpdateSchema.parse({ expectedVersion: 2, purpose: "EMBEDDING" })).toThrow();
    expect(providerConfigUpdateSchema.parse({ expectedVersion: 2, enabled: false })).toBeDefined();
    expect(() => providerProfileUpdateSchema.parse({ expectedVersion: 2, model: "chat-2" })).toThrow();
    expect(providerProfileUpdateSchema.parse({
      expectedVersion: 2,
      model: "chat-2",
      purpose: "CHAT",
      requiredCapabilities: { structuredOutput: true },
      capabilitySnapshot: {
        chat: true,
        embeddings: false,
        structuredOutput: true,
        maxInputTokens: 128_000,
        maxOutputTokens: 4096,
        probedAt: NOW,
        snapshotHash: SHA,
      },
    })).toBeDefined();
  });
});

describe("AI authorization grant claims", () => {
  const claims = {
    iss: "innorder-core",
    aud: "innorder-ai",
    typ: "ai_authorization_grant",
    jti: UUID,
    eventId: UUID_2,
    operationId: UUID_3,
    principalId: UUID,
    targetId: UUID_2,
    purpose: "PARTICIPANT_GUIDANCE",
    authorizationRevision: 17,
    policyReleaseDigest: SHA,
    authorizedSetDigest: SHA,
    contextDigest: SHA,
    classificationCeiling: "CONFIDENTIAL",
    iat: 1_785_581_800,
    nbf: 1_785_581_800,
    exp: 1_785_582_100,
    agentVersionId: UUID,
    modelProfileId: UUID_2,
    promptVersionId: UUID_3,
    packageVersionId: UUID,
    embeddingSpaceId: UUID_2,
  } as const;

  it("accepts exact five-minute single-use grant claims", () => {
    expect(aiGrantClaimsSchema.parse(claims)).toEqual(claims);
  });

  it("rejects missing, extra, malformed, or overlong grant claims", () => {
    const { contextDigest: _missing, ...missing } = claims;
    for (const invalid of [
      missing,
      { ...claims, secret: "must-not-appear" },
      { ...claims, aud: "other-service" },
      { ...claims, typ: "JWT" },
      { ...claims, jti: "not-a-uuid" },
      { ...claims, authorizationRevision: -1 },
      { ...claims, exp: claims.iat + 301 },
      { ...claims, exp: claims.iat },
      { ...claims, nbf: claims.exp + 1 },
      { ...claims, candidateEmbeddingSpaceId: UUID_2 },
    ]) expect(() => aiGrantClaimsSchema.parse(invalid)).toThrow();
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
      sourceId: UUID_2,
      documentId: UUID_3,
      sourceVersion: "source-v1",
      sourceObjectHash: SHA,
      normalizedContentHash: SHA,
      parserVersion: "parser-v1",
      chunkerVersion: "chunker-v1",
      candidateEmbeddingSpaceId: UUID,
      corpusManifestDigest: SHA,
      checkpoint: { page: 10 },
      stage: "EMBED",
      status: "RETRY",
      attempts: 2,
      maxAttempts: 5,
      nextAttemptAt: LATER,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(knowledgeIngestionJobSchema.parse(job)).toEqual(job);
    expect(knowledgeIngestionJobSchema.parse({
      ...job,
      producedDocumentVersionId: UUID_2,
      stage: "COMPLETE",
      status: "COMPLETED",
      completedAt: LATER,
    })).toBeDefined();
    expect(knowledgeIngestionJobSchema.parse({
      ...job,
      sanitizedError: "OCC-AI-INGESTION-RETRY",
    })).toBeDefined();
    expect(knowledgeIngestionJobSchema.parse({
      ...job,
      stage: "COMPLETE",
      status: "FAILED",
      sanitizedError: "OCC-AI-INGESTION-FAILED",
      completedAt: LATER,
    })).toBeDefined();
    expect(() => knowledgeIngestionJobSchema.parse({ ...job, stage: "QUALITY_GATE" })).toThrow();
    expect(() => knowledgeIngestionJobSchema.parse({ ...job, status: "RUNNING" })).toThrow();
    expect(() => knowledgeIngestionJobSchema.parse({ ...job, attempts: 6 })).toThrow();
    expect(() => knowledgeIngestionJobSchema.parse({
      ...job,
      status: "PROCESSING",
      leaseOwner: "worker-1",
      leaseExpiresAt: NOW,
    })).toThrow();
    expect(() => knowledgeIngestionJobSchema.parse({ ...job, status: "COMPLETED", stage: "COMPLETE", completedAt: LATER })).toThrow();
    expect(() => knowledgeIngestionJobSchema.parse({ ...job, status: "FAILED", completedAt: LATER })).toThrow();
    expect(() => knowledgeIngestionJobSchema.parse({
      ...job,
      stage: "COMPLETE",
      status: "FAILED",
      sanitizedError: "parser exploded",
      completedAt: LATER,
    })).toThrow();
    expect(() => knowledgeIngestionJobSchema.parse({
      ...job,
      producedDocumentVersionId: UUID_2,
      stage: "COMPLETE",
      status: "COMPLETED",
      sanitizedError: "OCC-AI-UNEXPECTED",
      completedAt: LATER,
    })).toThrow();
    expect(() => knowledgeIngestionJobSchema.parse({
      ...job,
      producedDocumentVersionId: UUID_2,
      stage: "COMPLETE",
      status: "FAILED",
      sanitizedError: "OCC-AI-INGESTION-FAILED",
      completedAt: LATER,
    })).toThrow();
    for (const status of ["PENDING", "PROCESSING"] as const) {
      const lease = status === "PROCESSING"
        ? { leaseOwner: "worker-1", leaseExpiresAt: LATER }
        : {};
      expect(() => knowledgeIngestionJobSchema.parse({
        ...job,
        ...lease,
        status,
        sanitizedError: "OCC-AI-UNEXPECTED",
      })).toThrow();
      expect(() => knowledgeIngestionJobSchema.parse({
        ...job,
        ...lease,
        status,
        producedDocumentVersionId: UUID_2,
      })).toThrow();
    }
    expect(() => knowledgeIngestionJobSchema.parse({
      ...job,
      producedDocumentVersionId: UUID_2,
    })).toThrow();
    expect(() => knowledgeIngestionJobSchema.parse({ ...job, providerBody: "secret" })).toThrow();
  });

  it("captures complete gate evidence and versioned activation or rollback", () => {
    const gate = {
      id: UUID,
      status: "COMPLETED",
      datasetVersionId: UUID_2,
      datasetContentHash: SHA,
      corpusManifestDigest: SHA,
      documentManifest: `${UUID_3}:${SHA}`,
      candidateEmbeddingSpaceId: UUID,
      expectedActiveSpaceId: UUID_2,
      eligibleCount: 100,
      embeddedCount: 100,
      coverage: 1,
      leakageCount: 0,
      citationSupportedCount: 95,
      citationTotalCount: 100,
      citationPrecision: 0.95,
      recallAt10Sum: 17,
      recallAt10CaseCount: 20,
      recallAt10Mean: 0.85,
      minimumCoverage: 1,
      maximumLeakage: 0,
      minimumCitationPrecision: 0.95,
      minimumRecallAt10: 0.85,
      decision: "PASS",
      evidenceHash: SHA,
      evaluatedAt: NOW,
    } as const;
    expect(knowledgeGateResultSchema.parse(gate)).toBeDefined();
    const metrics = {
      eligibleCount: gate.eligibleCount,
      embeddedCount: gate.embeddedCount,
      coverage: gate.coverage,
      leakageCount: gate.leakageCount,
      citationSupportedCount: gate.citationSupportedCount,
      citationTotalCount: gate.citationTotalCount,
      citationPrecision: gate.citationPrecision,
      recallAt10Sum: gate.recallAt10Sum,
      recallAt10CaseCount: gate.recallAt10CaseCount,
      recallAt10Mean: gate.recallAt10Mean,
      minimumCoverage: gate.minimumCoverage,
      maximumLeakage: gate.maximumLeakage,
      minimumCitationPrecision: gate.minimumCitationPrecision,
      minimumRecallAt10: gate.minimumRecallAt10,
      decision: gate.decision,
    } as const;
    expect(knowledgeGateMetricsSchema.parse(metrics)).toBeDefined();
    expect(() => knowledgeGateMetricsSchema.parse({ ...metrics, coverage: 0.99 })).toThrow();
    expect(knowledgeActivationRequestSchema.parse({
      gateResultId: UUID,
      evidenceHash: SHA,
      datasetVersionId: UUID_2,
      corpusManifestDigest: SHA,
      candidateEmbeddingSpaceId: UUID,
      expectedActiveSpaceId: UUID_2,
      expectedVersion: 4,
    })).toBeDefined();
    expect(knowledgeRollbackRequestSchema.parse({ targetVersionId: UUID_2, expectedVersion: 5 })).toBeDefined();
    for (const invalid of [
      { ...gate, embeddedCount: 99 },
      { ...gate, citationSupportedCount: 94 },
      { ...gate, recallAt10Sum: 16 },
      { ...gate, leakageCount: 1 },
      { ...gate, decision: "FAIL" },
      { ...gate, minimumCoverage: 0.99 },
    ]) expect(() => knowledgeGateResultSchema.parse(invalid)).toThrow();
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
    expect(guidanceStatusSchema.parse({
      operationId: UUID,
      status: "SUCCEEDED",
      recommendationId: UUID_2,
      requestedAt: NOW,
      updatedAt: LATER,
    })).toBeDefined();
    expect(() => guidanceStatusSchema.parse({ operationId: UUID, status: "SUCCEEDED", requestedAt: NOW, updatedAt: LATER })).toThrow();
    expect(() => guidanceStatusSchema.parse({ operationId: UUID, status: "FAILED", requestedAt: NOW, updatedAt: LATER })).toThrow();
    expect(guidanceStatusSchema.parse({
      operationId: UUID,
      status: "DEAD_LETTERED",
      errorCode: "OCC-AI-RETRY-EXHAUSTED",
      requestedAt: NOW,
      updatedAt: LATER,
    })).toBeDefined();
    expect(() => guidanceStatusSchema.parse({ operationId: UUID, status: "DEAD_LETTERED", requestedAt: NOW, updatedAt: LATER })).toThrow();
    expect(() => guidanceStatusSchema.parse({
      operationId: UUID,
      status: "CANCELLED",
      errorCode: "OCC-AI-CANCELLED",
      requestedAt: NOW,
      updatedAt: LATER,
    })).toThrow();
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

  it("requires stable failure outcomes and exact terminal payloads", () => {
    expect(serviceOperationOutcomeSchema.parse({ operationId: UUID, status: "FAILED", errorCode: "OCC-AI-PROVIDER-TIMEOUT", expectedVersion: 2 })).toBeDefined();
    expect(serviceIngestionOutcomeSchema.parse({
      operationId: UUID,
      jobId: UUID_2,
      status: "COMPLETED",
      producedDocumentVersionId: UUID_3,
      expectedVersion: 2,
    })).toBeDefined();
    expect(serviceProviderProbeOutcomeSchema.parse({
      operationId: UUID,
      probeId: UUID_2,
      status: "SUCCEEDED",
      completedAt: LATER,
      expectedVersion: 2,
      snapshot: {
        chat: true,
        embeddings: false,
        structuredOutput: true,
        maxInputTokens: 1000,
        maxOutputTokens: 100,
        probedAt: LATER,
        snapshotHash: SHA,
      },
    })).toBeDefined();
    for (const invalid of [
      { operationId: UUID, status: "FAILED", expectedVersion: 2 },
      { operationId: UUID, status: "FAILED", errorCode: "provider timeout", expectedVersion: 2 },
      { operationId: UUID, status: "SUCCEEDED", errorCode: "OCC-AI-UNEXPECTED", expectedVersion: 2 },
      { operationId: UUID, status: "FAILED", errorCode: "OCC-AI-UNEXPECTED" },
    ]) expect(() => serviceOperationOutcomeSchema.parse(invalid)).toThrow();
  });
});

describe("governed AI event contracts", () => {
  it("parses exact versioned payloads through the event envelope", () => {
    expect(knowledgeIngestionRequestedEventSchema.parse({
      ...envelope,
      type: "knowledge.ingestion-requested.v1",
      schemaVersion: 1,
      aggregateType: "KnowledgeDocument",
      payload: {
        operationId: UUID,
        ingestionJobId: UUID_2,
        sourceId: UUID_3,
        documentId: UUID,
        candidateEmbeddingSpaceId: UUID_2,
        sourceVersion: "source-v1",
        sourceObjectHash: SHA,
      },
    })).toBeDefined();
    expect(() => knowledgeIngestionRequestedEventSchema.parse({
      ...envelope,
      type: "knowledge.ingestion-requested.v1",
      schemaVersion: 1,
      aggregateType: "KnowledgeDocument",
      payload: {
        operationId: UUID,
        ingestionJobId: UUID_2,
        sourceId: UUID_3,
        candidateEmbeddingSpaceId: UUID_2,
        sourceVersion: "source-v1",
        sourceObjectHash: SHA,
      },
    })).toThrow();
    expect(aiGuidanceRequestedEventSchema.parse({
      ...envelope,
      type: "ai.guidance-requested.v1",
      schemaVersion: 1,
      aggregateType: "AiGuidanceOperation",
      payload: { operationId: UUID },
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
    const events = [
      [knowledgeIngestionRequestedEventSchema, {
        ...envelope,
        type: "knowledge.ingestion-requested.v1",
        schemaVersion: 1,
        aggregateType: "KnowledgeDocument",
        payload: {
          operationId: UUID,
          ingestionJobId: UUID_2,
          sourceId: UUID_3,
          documentId: UUID_2,
          candidateEmbeddingSpaceId: UUID,
          sourceVersion: "source-v1",
          sourceObjectHash: SHA,
        },
      }],
      [aiGuidanceRequestedEventSchema, {
        ...envelope,
        type: "ai.guidance-requested.v1",
        schemaVersion: 1,
        aggregateType: "AiGuidanceOperation",
        payload: { operationId: UUID },
      }],
      [aiRecommendationProposedEventSchema, {
        ...envelope,
        type: "ai.recommendation-proposed.v1",
        schemaVersion: 1,
        aggregateType: "AiRecommendation",
        payload: { operationId: UUID, recommendationId: UUID_2, runId: UUID_3 },
      }],
      [aiOperationDeadLetteredEventSchema, {
        ...envelope,
        type: "ai.operation-dead-lettered.v1",
        schemaVersion: 1,
        aggregateType: "AiGuidanceOperation",
        payload: {
          operationId: UUID,
          failedEventId: UUID_2,
          failedEventType: "ai.guidance-requested.v1",
          attempts: 5,
          errorCode: "OCC-AI-RETRY-EXHAUSTED",
        },
      }],
    ] as const;

    for (const [schema, event] of events) {
      expect(schema.parse(event)).toBeDefined();
      for (const extra of [
        { credential: "secret" },
        { grantToken: "a.b.c" },
        { content: "prompt" },
      ]) expect(() => schema.parse({ ...event, payload: { ...event.payload, ...extra } })).toThrow();
    }

    const guidance = events[1][1];
    expect(() => aiGuidanceRequestedEventSchema.parse({ ...guidance, schemaVersion: 2 })).toThrow();
    expect(() => aiGuidanceRequestedEventSchema.parse({ ...guidance, type: "ai.guidance-requested.v2" })).toThrow();
  });

  it("uses the bounded shared stable error code for dead letters", () => {
    const event = {
      ...envelope,
      type: "ai.operation-dead-lettered.v1",
      schemaVersion: 1,
      aggregateType: "AiGuidanceOperation",
      payload: {
        operationId: UUID,
        failedEventId: UUID_2,
        failedEventType: "ai.guidance-requested.v1",
        attempts: 5,
        errorCode: `OCC-AI-${"A".repeat(112)}`,
      },
    } as const;
    expect(aiOperationDeadLetteredEventSchema.parse(event)).toBeDefined();
    for (const errorCode of [
      "provider-timeout",
      "OCC-AI-provider-timeout",
      `OCC-AI-${"A".repeat(113)}`,
    ]) expect(() => aiOperationDeadLetteredEventSchema.parse({
      ...event,
      payload: { ...event.payload, errorCode },
    })).toThrow();
  });
});
