import { z } from "zod";

export const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
export const CURSOR_MAX_LENGTH = 1024;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
export const JWT_MAX_LENGTH = 8192;
export const SHA256_PATTERN = "^[a-f0-9]{64}$";

export const uuidSchema = z.uuid();
export const sha256Schema = z.string().regex(new RegExp(SHA256_PATTERN));
export const versionSchema = z.number().int().min(0).max(MAX_SAFE_INTEGER);
export const timestampSchema = z.iso.datetime({ offset: true });
export const boundedCursorSchema = z.string().min(1).max(CURSOR_MAX_LENGTH);
export const idempotencyKeySchema = z.string().min(1).max(IDEMPOTENCY_KEY_MAX_LENGTH);

export const DATA_CLASSIFICATION_ORDER = [
  "PUBLIC",
  "INTERNAL",
  "CONFIDENTIAL",
  "RESTRICTED",
] as const;
export const dataClassificationSchema = z.enum(DATA_CLASSIFICATION_ORDER);
export const providerPurposeSchema = z.enum(["CHAT", "EMBEDDING"]);

const isExactHttpsOrigin = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.origin === value
    );
  } catch {
    return false;
  }
};

const isNormalizedApiPrefix = (value: string): boolean =>
  value === "/" ||
  (/^\/(?:[A-Za-z0-9._~-]+)(?:\/[A-Za-z0-9._~-]+)*$/u.test(value) &&
    !value.split("/").some((segment) => segment === "." || segment === ".."));

export const exactHttpsProviderOriginSchema = z.string().min(9).max(2048).refine(isExactHttpsOrigin);
export const normalizedApiPrefixSchema = z.string().min(1).max(256).refine(isNormalizedApiPrefix);
export const approvedPrivateCidrSchema = z.union([z.cidrv4(), z.cidrv6()]);

export const providerConfigSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1).max(128),
    origin: exactHttpsProviderOriginSchema,
    apiPrefix: normalizedApiPrefixSchema,
    approvedPrivateCidrs: z.array(approvedPrivateCidrSchema).max(32),
    credentialFile: z.string().min(1).max(1024).regex(/^(?:\/|[A-Za-z]:\\)/u),
    enabled: z.boolean(),
    version: versionSchema,
  })
  .strict();

export const providerConfigCreateSchema = providerConfigSchema.omit({ id: true, version: true });
export const providerConfigUpdateSchema = providerConfigCreateSchema.partial().extend({ expectedVersion: versionSchema }).strict();

export const providerTimeoutsSchema = z
  .object({
    connectMs: z.number().int().min(100).max(60_000),
    totalMs: z.number().int().min(100).max(300_000),
  })
  .strict()
  .refine(({ connectMs, totalMs }) => connectMs <= totalMs);

export const providerRateLimitSchema = z
  .object({
    requestsPerMinute: z.number().int().min(1).max(1_000_000),
    tokensPerMinute: z.number().int().min(1).max(MAX_SAFE_INTEGER),
    maxConcurrency: z.number().int().min(1).max(1024),
  })
  .strict();

export const providerCostRuleSchema = z
  .object({
    currency: z.string().length(3).regex(/^[A-Z]{3}$/u),
    inputMicrosPerMillionTokens: z.number().int().min(0).max(MAX_SAFE_INTEGER),
    outputMicrosPerMillionTokens: z.number().int().min(0).max(MAX_SAFE_INTEGER),
  })
  .strict();

export const requiredProviderCapabilitiesSchema = z
  .object({
    structuredOutput: z.boolean(),
    embeddingDimensions: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict();

export const capabilitySnapshotSchema = z
  .object({
    chat: z.boolean(),
    embeddings: z.boolean(),
    structuredOutput: z.boolean(),
    embeddingDimensions: z.number().int().min(1).max(1_000_000).optional(),
    maxInputTokens: z.number().int().min(1).max(MAX_SAFE_INTEGER),
    maxOutputTokens: z.number().int().min(1).max(MAX_SAFE_INTEGER),
    probedAt: timestampSchema,
    snapshotHash: sha256Schema,
  })
  .strict()
  .refine(({ embeddings, embeddingDimensions }) => embeddings || embeddingDimensions === undefined);

export const providerProfileSchema = z
  .object({
    id: uuidSchema,
    providerId: uuidSchema,
    name: z.string().min(1).max(128),
    purpose: providerPurposeSchema,
    model: z.string().min(1).max(256),
    maxClassification: dataClassificationSchema,
    requiredCapabilities: requiredProviderCapabilitiesSchema,
    timeouts: providerTimeoutsSchema,
    rateLimit: providerRateLimitSchema,
    cost: providerCostRuleSchema,
    capabilitySnapshot: capabilitySnapshotSchema,
    enabled: z.boolean(),
    version: versionSchema,
  })
  .strict();

export const providerProfileCreateSchema = providerProfileSchema.omit({ id: true, version: true });
export const providerProfileUpdateSchema = providerProfileCreateSchema.partial().extend({ expectedVersion: versionSchema }).strict();
export const capabilityProbeRequestSchema = z.object({ providerId: uuidSchema }).strict();
export const capabilityProbeStatusSchema = z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]);
export const capabilityProbeSchema = z
  .object({
    id: uuidSchema,
    providerId: uuidSchema,
    status: capabilityProbeStatusSchema,
    requestedAt: timestampSchema,
    completedAt: timestampSchema.optional(),
    snapshot: capabilitySnapshotSchema.optional(),
    errorCode: z.string().min(1).max(128).optional(),
  })
  .strict();

export const knowledgeFormatSchema = z.enum(["TEXT", "MARKDOWN", "PDF", "DOCX", "XLSX"]);
export const knowledgeUploadMetadataSchema = z
  .object({
    fileName: z.string().min(1).max(255),
    mediaType: z.string().min(1).max(255),
    format: knowledgeFormatSchema,
    title: z.string().min(1).max(256),
    classification: dataClassificationSchema,
    sizeBytes: z.number().int().min(1).max(100 * 1024 * 1024),
    contentHash: sha256Schema,
  })
  .strict();

export const knowledgeIngestionStageSchema = z.enum([
  "QUARANTINE",
  "MALWARE_SCAN",
  "PARSE",
  "NORMALIZE",
  "CHUNK",
  "EMBED",
  "QUALITY_GATE",
  "COMPLETE",
]);
export const knowledgeIngestionStatusSchema = z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"]);
export const knowledgeIngestionJobSchema = z
  .object({
    id: uuidSchema,
    documentVersionId: uuidSchema,
    stage: knowledgeIngestionStageSchema,
    status: knowledgeIngestionStatusSchema,
    progressPercent: z.number().int().min(0).max(100),
    attempt: z.number().int().min(0).max(100),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    errorCode: z.string().min(1).max(128).optional(),
  })
  .strict();

export const knowledgeGateMetricsSchema = z
  .object({
    coverage: z.number().min(0).max(1),
    unauthorizedHits: z.number().int().min(0).max(MAX_SAFE_INTEGER),
    citationPrecision: z.number().min(0).max(1),
    recallAt10: z.number().min(0).max(1),
  })
  .strict();
export const knowledgeGateDecisionSchema = z.enum(["PASS", "FAIL"]);
export const knowledgeGateResultSchema = z
  .object({
    id: uuidSchema,
    embeddingSpaceId: uuidSchema,
    corpusManifestHash: sha256Schema,
    metrics: knowledgeGateMetricsSchema,
    decision: knowledgeGateDecisionSchema,
    evaluatedAt: timestampSchema,
  })
  .strict();
export const knowledgeActivationRequestSchema = z.object({ gateResultId: uuidSchema, expectedVersion: versionSchema }).strict();
export const knowledgeRollbackRequestSchema = z.object({ targetVersionId: uuidSchema, expectedVersion: versionSchema }).strict();

export const guidanceRequestSchema = z
  .object({
    targetEntityId: uuidSchema,
    taskId: uuidSchema,
    providerProfileId: uuidSchema,
    expectedTargetVersion: versionSchema,
  })
  .strict();
export const guidanceOperationStatusSchema = z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "DEAD_LETTERED"]);
export const guidanceStatusSchema = z
  .object({
    operationId: uuidSchema,
    status: guidanceOperationStatusSchema,
    recommendationId: uuidSchema.optional(),
    errorCode: z.string().min(1).max(128).optional(),
    requestedAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const serviceGrantClaimSchema = z.object({ operationId: uuidSchema }).strict();
export const serviceGrantExchangeSchema = z
  .object({
    operationId: uuidSchema,
    grantToken: z.string().min(3).max(JWT_MAX_LENGTH).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u),
  })
  .strict();

export const citationSchema = z
  .object({
    rank: z.number().int().min(1).max(50),
    retrievalHitId: uuidSchema,
    excerptHash: sha256Schema,
  })
  .strict();
export const guidanceStepSchema = z
  .object({
    text: z.string().min(1).max(2000),
    citationRanks: z.array(z.number().int().min(1).max(50)).min(1).max(10),
  })
  .strict();
export const generatedRecommendationSchema = z
  .object({
    generatedContent: z.literal(true),
    summary: z.string().min(1).max(2000),
    steps: z.array(guidanceStepSchema).min(1).max(20),
    confidence: z.number().min(0).max(1),
    citations: z.array(citationSchema).min(1).max(50),
  })
  .strict()
  .superRefine(({ steps, citations }, context) => {
    const ranks = new Set<number>();
    const hits = new Set<string>();
    for (const citation of citations) {
      if (ranks.has(citation.rank)) context.addIssue({ code: "custom", message: "Citation ranks must be unique", path: ["citations"] });
      if (hits.has(citation.retrievalHitId.toLowerCase())) context.addIssue({ code: "custom", message: "Citation retrieval hits must be unique", path: ["citations"] });
      ranks.add(citation.rank);
      hits.add(citation.retrievalHitId.toLowerCase());
    }
    steps.forEach((step, stepIndex) => {
      const stepRanks = new Set(step.citationRanks);
      if (stepRanks.size !== step.citationRanks.length) {
        context.addIssue({ code: "custom", message: "Step citation ranks must be unique", path: ["steps", stepIndex, "citationRanks"] });
      }
      step.citationRanks.forEach((rank, rankIndex) => {
        if (!ranks.has(rank)) context.addIssue({ code: "custom", message: "Cited rank does not exist", path: ["steps", stepIndex, "citationRanks", rankIndex] });
      });
    });
  });
export const guidanceOutputSchema = generatedRecommendationSchema;

export const recommendationStatusSchema = z.enum(["PROPOSED", "ACCEPTED", "REJECTED"]);
export const recommendationStaleReasonSchema = z.enum([
  "PACKAGE_VERSION_CHANGED",
  "POLICY_RELEASE_CHANGED",
  "DOCUMENT_VERSION_CHANGED",
  "PROVIDER_CAPABILITY_CHANGED",
  "TARGET_VERSION_CHANGED",
  "AI_UNAVAILABLE",
]);
export const recommendationItemSchema = z
  .object({
    id: uuidSchema,
    targetEntityId: uuidSchema,
    status: recommendationStatusSchema,
    summary: z.string().min(1).max(2000),
    confidence: z.number().min(0).max(1),
    staleReasons: z.array(recommendationStaleReasonSchema).max(6),
    version: versionSchema,
    createdAt: timestampSchema,
  })
  .strict();
export const recommendationListSchema = z
  .object({
    items: z.array(recommendationItemSchema).max(100),
    nextCursor: boundedCursorSchema.optional(),
  })
  .strict();
export const recommendationDetailSchema = recommendationItemSchema.extend({ output: generatedRecommendationSchema }).strict();
export const recommendationReviewRequestSchema = z
  .object({
    decision: z.enum(["ACCEPTED", "REJECTED"]),
    expectedVersion: versionSchema,
    comment: z.string().min(1).max(2000).optional(),
  })
  .strict();
export const serviceRecommendationSubmissionSchema = z
  .object({
    operationId: uuidSchema,
    runId: uuidSchema,
    targetEntityId: uuidSchema,
    expectedTargetVersion: versionSchema,
    output: generatedRecommendationSchema,
  })
  .strict();
export const serviceOperationOutcomeSchema = z
  .object({
    operationId: uuidSchema,
    status: z.enum(["SUCCEEDED", "FAILED"]),
    errorCode: z.string().min(1).max(128).optional(),
  })
  .strict();

export type DataClassification = z.infer<typeof dataClassificationSchema>;
export type ProviderPurpose = z.infer<typeof providerPurposeSchema>;
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ProviderProfile = z.infer<typeof providerProfileSchema>;
export type CapabilitySnapshot = z.infer<typeof capabilitySnapshotSchema>;
export type CapabilityProbe = z.infer<typeof capabilityProbeSchema>;
export type KnowledgeUploadMetadata = z.infer<typeof knowledgeUploadMetadataSchema>;
export type KnowledgeIngestionJob = z.infer<typeof knowledgeIngestionJobSchema>;
export type KnowledgeGateResult = z.infer<typeof knowledgeGateResultSchema>;
export type GuidanceRequest = z.infer<typeof guidanceRequestSchema>;
export type GuidanceStatus = z.infer<typeof guidanceStatusSchema>;
export type GeneratedRecommendation = z.infer<typeof generatedRecommendationSchema>;
export type RecommendationItem = z.infer<typeof recommendationItemSchema>;
export type RecommendationDetail = z.infer<typeof recommendationDetailSchema>;
export type RecommendationReviewRequest = z.infer<typeof recommendationReviewRequestSchema>;
export type ServiceGrantClaim = z.infer<typeof serviceGrantClaimSchema>;
export type ServiceGrantExchange = z.infer<typeof serviceGrantExchangeSchema>;
