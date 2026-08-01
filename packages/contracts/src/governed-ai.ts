import { z } from "zod";

export const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
export const CURSOR_MAX_LENGTH = 1024;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
export const JWT_MAX_LENGTH = 8192;
export const SHA256_PATTERN = "^[a-f0-9]{64}$";
export const STABLE_AI_ERROR_CODE_PATTERN = "^OCC-AI-[A-Z0-9-]{1,112}$";

export const uuidSchema = z.uuid();
export const sha256Schema = z.string().regex(new RegExp(SHA256_PATTERN));
export const versionSchema = z.number().int().min(0).max(MAX_SAFE_INTEGER);
export const timestampSchema = z.iso.datetime({ offset: true });
export const boundedCursorSchema = z.string().min(1).max(CURSOR_MAX_LENGTH);
export const idempotencyKeySchema = z.string().min(1).max(IDEMPOTENCY_KEY_MAX_LENGTH);
export const stableAiErrorCodeSchema = z
  .string()
  .min(8)
  .max(119)
  .regex(new RegExp(STABLE_AI_ERROR_CODE_PATTERN));

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
export const approvedPrivateCidrSchema = z
  .union([z.cidrv4(), z.cidrv6()])
  .refine((cidr) => {
    const separator = cidr.lastIndexOf("/");
    const address = cidr.slice(0, separator);
    const prefix = Number(cidr.slice(separator + 1));
    if (address.includes(":")) {
      const firstHextet = Number.parseInt(address.split(":", 1)[0] ?? "", 16);
      return prefix >= 7 && Number.isInteger(firstHextet) && (firstHextet & 0xfe00) === 0xfc00;
    }
    const octets = address.split(".").map(Number);
    const first = octets[0];
    const second = octets[1];
    return (
      (first === 10 && prefix >= 8) ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31 && prefix >= 12) ||
      (first === 192 && second === 168 && prefix >= 16)
    );
  });

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
export const providerConfigListSchema = z
  .object({
    items: z.array(providerConfigSchema).max(100),
    nextCursor: boundedCursorSchema.optional(),
  })
  .strict();
export const providerConfigUpdateSchema = providerConfigCreateSchema
  .partial()
  .extend({ expectedVersion: versionSchema })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== "expectedVersion"));

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
  .refine(({ embeddings, embeddingDimensions }) => embeddings === (embeddingDimensions !== undefined));

const providerProfileObjectSchema = z
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

const refineProviderProfile = (
  { purpose, requiredCapabilities, capabilitySnapshot }: Pick<
    z.infer<typeof providerProfileObjectSchema>,
    "purpose" | "requiredCapabilities" | "capabilitySnapshot"
  >,
  context: z.RefinementCtx,
): void => {
    if (purpose === "CHAT" && !capabilitySnapshot.chat) {
      context.addIssue({ code: "custom", message: "Chat profiles require chat capability", path: ["capabilitySnapshot", "chat"] });
    }
    if (purpose === "EMBEDDING" && (!capabilitySnapshot.embeddings || capabilitySnapshot.embeddingDimensions === undefined)) {
      context.addIssue({ code: "custom", message: "Embedding profiles require embedding dimensions", path: ["capabilitySnapshot"] });
    }
    if (requiredCapabilities.structuredOutput && !capabilitySnapshot.structuredOutput) {
      context.addIssue({ code: "custom", message: "Structured output capability is required", path: ["capabilitySnapshot", "structuredOutput"] });
    }
    if (
      requiredCapabilities.embeddingDimensions !== undefined &&
      requiredCapabilities.embeddingDimensions !== capabilitySnapshot.embeddingDimensions
    ) {
      context.addIssue({ code: "custom", message: "Embedding dimensions do not match", path: ["capabilitySnapshot", "embeddingDimensions"] });
    }
  };

export const providerProfileSchema = providerProfileObjectSchema.superRefine(refineProviderProfile);

const providerProfileCreateObjectSchema = providerProfileObjectSchema.omit({ id: true, version: true });
export const providerProfileCreateSchema = providerProfileCreateObjectSchema.superRefine(refineProviderProfile);
export const providerProfileListSchema = z
  .object({
    items: z.array(providerProfileSchema).max(100),
    nextCursor: boundedCursorSchema.optional(),
  })
  .strict();
export const providerProfileUpdateSchema = providerProfileCreateObjectSchema
  .partial()
  .extend({ expectedVersion: versionSchema })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== "expectedVersion"))
  .superRefine((value, context) => {
    const compatibilityValues = [value.purpose, value.requiredCapabilities, value.capabilitySnapshot];
    const present = compatibilityValues.filter((item) => item !== undefined).length;
    const changesCompatibility = value.model !== undefined || present > 0;
    if (changesCompatibility && present < compatibilityValues.length) {
      context.addIssue({ code: "custom", message: "Compatibility changes require purpose, requirements, and snapshot", path: [] });
    } else if (present === compatibilityValues.length) {
      refineProviderProfile(value as Required<Pick<
        z.infer<typeof providerProfileCreateObjectSchema>,
        "purpose" | "requiredCapabilities" | "capabilitySnapshot"
      >>, context);
    }
  });
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
    errorCode: stableAiErrorCodeSchema.optional(),
  })
  .strict()
  .superRefine(({ status, completedAt, snapshot, errorCode }, context) => {
    const success = status === "SUCCEEDED";
    const failure = status === "FAILED";
    if (success && (completedAt === undefined || snapshot === undefined || errorCode !== undefined)) {
      context.addIssue({ code: "custom", message: "Successful probes require completion and a snapshot", path: ["status"] });
    }
    if (failure && (completedAt === undefined || errorCode === undefined || snapshot !== undefined)) {
      context.addIssue({ code: "custom", message: "Failed probes require completion and an error code", path: ["status"] });
    }
    if (!success && !failure && (completedAt !== undefined || snapshot !== undefined || errorCode !== undefined)) {
      context.addIssue({ code: "custom", message: "Incomplete probes cannot contain outcomes", path: ["status"] });
    }
  });

export const jwtNumericDateSchema = z.number().int().min(0).max(MAX_SAFE_INTEGER);
export const aiGrantClaimsSchema = z
  .object({
    iss: z.literal("innorder-core"),
    aud: z.literal("innorder-ai"),
    typ: z.literal("ai_authorization_grant"),
    jti: uuidSchema,
    eventId: uuidSchema,
    operationId: uuidSchema,
    principalId: uuidSchema,
    targetId: uuidSchema,
    purpose: z.literal("PARTICIPANT_GUIDANCE"),
    authorizationRevision: versionSchema,
    policyReleaseDigest: sha256Schema,
    authorizedSetDigest: sha256Schema,
    contextDigest: sha256Schema,
    classificationCeiling: dataClassificationSchema,
    iat: jwtNumericDateSchema,
    nbf: jwtNumericDateSchema,
    exp: jwtNumericDateSchema,
    agentVersionId: uuidSchema,
    modelProfileId: uuidSchema,
    promptVersionId: uuidSchema,
    packageVersionId: uuidSchema,
    embeddingSpaceId: uuidSchema,
  })
  .strict()
  .refine(({ iat, nbf, exp }) => nbf <= exp && exp > iat && exp - iat <= 300);

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
  "DISCOVER",
  "FETCH",
  "PARSE",
  "CHUNK",
  "EMBED",
  "COMPLETE",
]);
export const knowledgeIngestionStatusSchema = z.enum(["PENDING", "PROCESSING", "RETRY", "COMPLETED", "FAILED"]);
export const knowledgeCheckpointSchema = z
  .record(z.string().min(1).max(128), z.json())
  .refine((value) => JSON.stringify(value).length <= 32_768);
export const knowledgeIngestionJobSchema = z
  .object({
    id: uuidSchema,
    sourceId: uuidSchema,
    documentId: uuidSchema.optional(),
    producedDocumentVersionId: uuidSchema.optional(),
    sourceVersion: z.string().min(1).max(256),
    sourceObjectHash: sha256Schema,
    normalizedContentHash: sha256Schema,
    parserVersion: z.string().min(1).max(128).regex(/^[^\x00-\x1F\x7F]+$/u),
    chunkerVersion: z.string().min(1).max(128).regex(/^[^\x00-\x1F\x7F]+$/u),
    candidateEmbeddingSpaceId: uuidSchema,
    corpusManifestDigest: sha256Schema,
    checkpoint: knowledgeCheckpointSchema,
    stage: knowledgeIngestionStageSchema,
    status: knowledgeIngestionStatusSchema,
    attempts: z.number().int().min(0).max(100),
    maxAttempts: z.number().int().min(1).max(100),
    nextAttemptAt: timestampSchema,
    leaseOwner: z.string().min(1).max(256).optional(),
    leaseExpiresAt: timestampSchema.optional(),
    errorCode: stableAiErrorCodeSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    completedAt: timestampSchema.optional(),
  })
  .strict()
  .superRefine((job, context) => {
    if (job.attempts > job.maxAttempts) {
      context.addIssue({ code: "custom", message: "Attempts exceed maximum", path: ["attempts"] });
    }
    const leased = job.leaseOwner !== undefined && job.leaseExpiresAt !== undefined;
    if ((job.status === "PROCESSING") !== leased) {
      context.addIssue({ code: "custom", message: "Processing jobs require a complete lease", path: ["status"] });
    }
    if ((job.leaseOwner === undefined) !== (job.leaseExpiresAt === undefined)) {
      context.addIssue({ code: "custom", message: "Lease owner and expiry must appear together", path: ["leaseOwner"] });
    }
    if (job.leaseExpiresAt !== undefined && Date.parse(job.leaseExpiresAt) <= Date.parse(job.createdAt)) {
      context.addIssue({ code: "custom", message: "Lease expiry must follow job creation", path: ["leaseExpiresAt"] });
    }
    const produced = job.producedDocumentVersionId !== undefined;
    const errored = job.errorCode !== undefined;
    if (job.status === "COMPLETED" && (!produced || errored || job.completedAt === undefined || job.stage !== "COMPLETE")) {
      context.addIssue({ code: "custom", message: "Completed jobs require only their produced version", path: ["status"] });
    }
    if (job.status === "FAILED" && (!errored || produced || job.completedAt === undefined)) {
      context.addIssue({ code: "custom", message: "Failed jobs require only a sanitized error", path: ["status"] });
    }
    if ((job.status === "PENDING" || job.status === "PROCESSING") && (produced || errored)) {
      context.addIssue({ code: "custom", message: "Pending and processing jobs cannot contain outcomes", path: ["status"] });
    }
    if (job.status === "RETRY" && produced) {
      context.addIssue({ code: "custom", message: "Retry jobs cannot contain a produced version", path: ["status"] });
    }
    if (job.status !== "COMPLETED" && job.status !== "FAILED" && job.completedAt !== undefined) {
      context.addIssue({ code: "custom", message: "Only terminal jobs have completion times", path: ["completedAt"] });
    }
  });

const knowledgeGateMetricsObjectSchema = z
  .object({
    eligibleCount: z.number().int().min(1).max(MAX_SAFE_INTEGER),
    embeddedCount: z.number().int().min(0).max(MAX_SAFE_INTEGER),
    coverage: z.number().min(0).max(1),
    leakageCount: z.number().int().min(0).max(MAX_SAFE_INTEGER),
    citationSupportedCount: z.number().int().min(0).max(MAX_SAFE_INTEGER),
    citationTotalCount: z.number().int().min(1).max(MAX_SAFE_INTEGER),
    citationPrecision: z.number().min(0).max(1),
    recallAt10Sum: z.number().min(0).max(MAX_SAFE_INTEGER),
    recallAt10CaseCount: z.number().int().min(1).max(MAX_SAFE_INTEGER),
    recallAt10Mean: z.number().min(0).max(1),
    minimumCoverage: z.literal(1),
    maximumLeakage: z.literal(0),
    minimumCitationPrecision: z.literal(0.95),
    minimumRecallAt10: z.literal(0.85),
    decision: z.enum(["PASS", "FAIL"]),
  })
  .strict();

const refineKnowledgeGateMetrics = (
  gate: z.infer<typeof knowledgeGateMetricsObjectSchema>,
  context: z.RefinementCtx,
): void => {
  const close = (left: number, right: number): boolean => Math.abs(left - right) <= 1e-12;
  const ratiosMatch =
    gate.embeddedCount <= gate.eligibleCount &&
    gate.citationSupportedCount <= gate.citationTotalCount &&
    gate.recallAt10Sum <= gate.recallAt10CaseCount &&
    close(gate.coverage, gate.embeddedCount / gate.eligibleCount) &&
    close(gate.citationPrecision, gate.citationSupportedCount / gate.citationTotalCount) &&
    close(gate.recallAt10Mean, gate.recallAt10Sum / gate.recallAt10CaseCount);
  const passes =
    ratiosMatch &&
    gate.coverage >= gate.minimumCoverage &&
    gate.leakageCount <= gate.maximumLeakage &&
    gate.citationPrecision >= gate.minimumCitationPrecision &&
    gate.recallAt10Mean >= gate.minimumRecallAt10;
  if (!ratiosMatch || (gate.decision === "PASS") !== passes) {
    context.addIssue({ code: "custom", message: "Gate metrics and decision are inconsistent", path: ["decision"] });
  }
};

export const knowledgeGateMetricsSchema = knowledgeGateMetricsObjectSchema.superRefine(refineKnowledgeGateMetrics);
export const knowledgeGateDecisionSchema = z.enum(["PASS", "FAIL"]);
export const knowledgeGateResultSchema = z
  .object({
    id: uuidSchema,
    status: z.literal("COMPLETED"),
    datasetVersionId: uuidSchema,
    datasetContentHash: sha256Schema,
    corpusManifestDigest: sha256Schema,
    documentManifest: z.string().min(1).max(65_536),
    candidateEmbeddingSpaceId: uuidSchema,
    expectedActiveSpaceId: uuidSchema,
    ...knowledgeGateMetricsObjectSchema.shape,
    evidenceHash: sha256Schema,
    evaluatedAt: timestampSchema,
  })
  .strict()
  .superRefine(refineKnowledgeGateMetrics);
export const knowledgeActivationRequestSchema = z
  .object({
    gateResultId: uuidSchema,
    evidenceHash: sha256Schema,
    datasetVersionId: uuidSchema,
    corpusManifestDigest: sha256Schema,
    candidateEmbeddingSpaceId: uuidSchema,
    expectedActiveSpaceId: uuidSchema,
    expectedVersion: versionSchema,
  })
  .strict();
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
    errorCode: stableAiErrorCodeSchema.optional(),
    requestedAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine(({ status, recommendationId, errorCode }, context) => {
    const failure = status === "FAILED" || status === "DEAD_LETTERED";
    if (status === "SUCCEEDED" && (recommendationId === undefined || errorCode !== undefined)) {
      context.addIssue({ code: "custom", message: "Successful guidance requires a recommendation", path: ["status"] });
    }
    if (failure && (errorCode === undefined || recommendationId !== undefined)) {
      context.addIssue({ code: "custom", message: "Failed guidance requires an error code", path: ["status"] });
    }
    if (status !== "SUCCEEDED" && !failure && (recommendationId !== undefined || errorCode !== undefined)) {
      context.addIssue({ code: "custom", message: "Incomplete guidance cannot contain an outcome", path: ["status"] });
    }
  });

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
    errorCode: stableAiErrorCodeSchema.optional(),
    expectedVersion: versionSchema,
  })
  .strict()
  .refine(({ status, errorCode }) => (status === "FAILED") === (errorCode !== undefined));
export const serviceIngestionOutcomeSchema = z
  .object({
    operationId: uuidSchema,
    jobId: uuidSchema,
    status: z.enum(["COMPLETED", "FAILED"]),
    producedDocumentVersionId: uuidSchema.optional(),
    errorCode: stableAiErrorCodeSchema.optional(),
    expectedVersion: versionSchema,
  })
  .strict()
  .refine(({ status, producedDocumentVersionId, errorCode }) =>
    status === "COMPLETED"
      ? producedDocumentVersionId !== undefined && errorCode === undefined
      : producedDocumentVersionId === undefined && errorCode !== undefined,
  );
export const serviceProviderProbeOutcomeSchema = z
  .object({
    operationId: uuidSchema,
    probeId: uuidSchema,
    status: z.enum(["SUCCEEDED", "FAILED"]),
    completedAt: timestampSchema,
    snapshot: capabilitySnapshotSchema.optional(),
    errorCode: stableAiErrorCodeSchema.optional(),
    expectedVersion: versionSchema,
  })
  .strict()
  .refine(({ status, snapshot, errorCode }) =>
    status === "SUCCEEDED"
      ? snapshot !== undefined && errorCode === undefined
      : snapshot === undefined && errorCode !== undefined,
  );

export type DataClassification = z.infer<typeof dataClassificationSchema>;
export type ProviderPurpose = z.infer<typeof providerPurposeSchema>;
export type AiGrantClaims = z.infer<typeof aiGrantClaimsSchema>;
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
export type ServiceIngestionOutcome = z.infer<typeof serviceIngestionOutcomeSchema>;
export type ServiceProviderProbeOutcome = z.infer<typeof serviceProviderProbeOutcomeSchema>;
