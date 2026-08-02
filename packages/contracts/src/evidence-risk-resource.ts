import { z } from "zod";

import { problemDetailsSchema } from "./problem-details.js";

export {
  OCC_PROBLEM_CODES,
  occProblemCodeSchema,
} from "./problem-details.js";
export type { OccProblemCode } from "./problem-details.js";

export const MAX_EVIDENCE_BYTES = 100 * 1024 * 1024;
export const MAX_EXPANDED_ARCHIVE_BYTES = MAX_EVIDENCE_BYTES * 2;
export const MAX_SAFE_VERSION = Number.MAX_SAFE_INTEGER;
export const SHA256_PATTERN = "^[0-9a-f]{64}$";
export const ISO_OFFSET_INSTANT_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$";
export const OPAQUE_CURSOR_PATTERN = "^[A-Za-z0-9._~-]{8,2048}$";
export const EVIDENCE_RANGE_PATTERN =
  "^bytes=(?:[0-9]{1,16}-[0-9]{0,16}|-[1-9][0-9]{0,15})$";
export const EVIDENCE_CONTENT_RANGE_PATTERN =
  "^bytes [0-9]{1,16}-[0-9]{1,16}/[0-9]{1,16}$";
export const EVIDENCE_UNSATISFIED_CONTENT_RANGE_PATTERN =
  "^bytes \\*/[0-9]{1,16}$";

export const domainProblemDetailsSchema = problemDetailsSchema;

const fixedDomainProblemDetailsSchema = <
  S extends number,
  C extends z.infer<typeof problemDetailsSchema.shape.code>,
>(status: S, code: C) =>
  domainProblemDetailsSchema
    .extend({ status: z.literal(status), code: z.literal(code) })
    .strict();

export const evidenceUploadConflictProblemSchema = fixedDomainProblemDetailsSchema(
  409,
  "OCC-EVIDENCE-UPLOAD-CONFLICT",
);
export const evidenceReviewConflictProblemSchema = fixedDomainProblemDetailsSchema(
  409,
  "OCC-EVIDENCE-REVIEW-CONFLICT",
);
export const riskInvalidTransitionProblemSchema = fixedDomainProblemDetailsSchema(
  409,
  "OCC-RISK-INVALID-TRANSITION",
);
export const resourceUnavailableProblemSchema = fixedDomainProblemDetailsSchema(
  409,
  "OCC-RESOURCE-UNAVAILABLE",
);
export const idempotencyConflictProblemSchema = fixedDomainProblemDetailsSchema(
  409,
  "OCC-COMMAND-IDEMPOTENCY-CONFLICT",
);
export const idempotencyInProgressProblemSchema = fixedDomainProblemDetailsSchema(
  409,
  "OCC-COMMAND-IDEMPOTENCY-IN-PROGRESS",
);
export const idempotencyExpiredProblemSchema = fixedDomainProblemDetailsSchema(
  409,
  "OCC-COMMAND-IDEMPOTENCY-EXPIRED",
);
export const versionConflictProblemSchema = domainProblemDetailsSchema
  .extend({
    status: z.literal(409),
    code: z.literal("OCC-COMMAND-OPTIMISTIC-CONFLICT"),
    currentVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export const authorizationUnavailableProblemSchema = fixedDomainProblemDetailsSchema(
  503,
  "OCC-AUTHZ-UNAVAILABLE",
);
export const commandIntegrityProblemSchema = fixedDomainProblemDetailsSchema(
  503,
  "OCC-COMMAND-INTEGRITY",
);
export const evidenceTooLargeProblemSchema = fixedDomainProblemDetailsSchema(
  413,
  "OCC-EVIDENCE-TOO-LARGE",
);
export const evidenceDigestMismatchProblemSchema = fixedDomainProblemDetailsSchema(
  422,
  "OCC-EVIDENCE-DIGEST-MISMATCH",
);
export const evidenceInvalidContentProblemSchema = fixedDomainProblemDetailsSchema(
  422,
  "OCC-EVIDENCE-INVALID-CONTENT",
);
export const unprocessableContentProblemSchema = z.union([
  evidenceDigestMismatchProblemSchema,
  evidenceInvalidContentProblemSchema,
]);
export const invalidRangeProblemSchema = fixedDomainProblemDetailsSchema(
  416,
  "OCC-INVALID-REQUEST",
);

export const riskAdjudicationConflictProblemSchema = z.union([
  idempotencyConflictProblemSchema,
  idempotencyInProgressProblemSchema,
  idempotencyExpiredProblemSchema,
]);

const kernelIdempotencyConflictSchemas = [
  idempotencyConflictProblemSchema,
  idempotencyInProgressProblemSchema,
  idempotencyExpiredProblemSchema,
] as const;

export const evidenceUploadSessionConflictProblemSchema = z.union([
  ...kernelIdempotencyConflictSchemas,
  versionConflictProblemSchema,
  evidenceUploadConflictProblemSchema,
]);
export const evidenceContentConflictProblemSchema = z.union([
  ...kernelIdempotencyConflictSchemas,
  evidenceUploadConflictProblemSchema,
]);
export const evidenceSubmitConflictProblemSchema = z.union([
  ...kernelIdempotencyConflictSchemas,
  versionConflictProblemSchema,
  evidenceUploadConflictProblemSchema,
]);
export const evidenceReviewCommandConflictProblemSchema = z.union([
  ...kernelIdempotencyConflictSchemas,
  versionConflictProblemSchema,
  evidenceReviewConflictProblemSchema,
]);
export const riskActionConflictProblemSchema = z.union([
  ...kernelIdempotencyConflictSchemas,
  versionConflictProblemSchema,
  riskInvalidTransitionProblemSchema,
]);
export const reservationCancelConflictProblemSchema = z.union([
  ...kernelIdempotencyConflictSchemas,
  versionConflictProblemSchema,
]);
export const protectedCommandUnavailableProblemSchema = z.union([
  authorizationUnavailableProblemSchema,
  commandIntegrityProblemSchema,
]);

const boundedText = (maximum: number, minimum = 1) =>
  z.string().trim().min(minimum).max(maximum);
const versionSchema = z.number().int().nonnegative().max(MAX_SAFE_VERSION);
const positiveIntegerSchema = z.number().int().positive().max(MAX_SAFE_VERSION);
const positiveCapacitySchema = z.number().finite().positive().max(MAX_SAFE_VERSION);
const sha256Schema = z.string().regex(new RegExp(SHA256_PATTERN));
const instantSchema = z
  .iso.datetime({ offset: true })
  .regex(new RegExp(ISO_OFFSET_INSTANT_PATTERN));
const dateSchema = z.iso.date();

export const opaqueCursorSchema = z
  .string()
  .min(8)
  .max(2048)
  .regex(new RegExp(OPAQUE_CURSOR_PATTERN));

const parseSafeRangeInteger = (value: string): number | undefined => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

export const evidenceRangeHeaderSchema = z
  .string()
  .max(39)
  .regex(new RegExp(EVIDENCE_RANGE_PATTERN))
  .superRefine((value, context) => {
    const specification = value.slice("bytes=".length);
    if (specification.startsWith("-")) {
      const suffixLength = parseSafeRangeInteger(specification.slice(1));
      if (suffixLength === undefined || suffixLength <= 0) {
        context.addIssue({ code: "custom", message: "suffix byte range must be a positive safe integer" });
      }
      return;
    }
    const [startText, endText] = specification.split("-");
    const start = parseSafeRangeInteger(startText ?? "");
    const end = endText ? parseSafeRangeInteger(endText) : undefined;
    if (start === undefined || (endText && end === undefined)) {
      context.addIssue({ code: "custom", message: "byte range bounds must be safe integers" });
    } else if (end !== undefined && end < start) {
      context.addIssue({ code: "custom", message: "byte range end must not precede start" });
    }
  });

export const evidenceContentRangeHeaderSchema = z
  .string()
  .max(56)
  .regex(new RegExp(EVIDENCE_CONTENT_RANGE_PATTERN));

export const evidenceUnsatisfiedContentRangeHeaderSchema = z
  .string()
  .max(24)
  .regex(new RegExp(EVIDENCE_UNSATISFIED_CONTENT_RANGE_PATTERN));

export const halfOpenIntervalSchema = z
  .object({
    start: instantSchema,
    end: instantSchema,
  })
  .strict()
  .refine(({ start, end }) => Date.parse(start) < Date.parse(end), {
    message: "end must be later than start for the half-open [start, end) interval",
    path: ["end"],
  });

export type HalfOpenInterval = z.infer<typeof halfOpenIntervalSchema>;

const pageFields = {
  nextCursor: opaqueCursorSchema.optional(),
  previousCursor: opaqueCursorSchema.optional(),
} as const;

export const evidenceStateSchema = z.enum([
  "PENDING",
  "SUBMITTED",
  "ACCEPTED",
  "REJECTED",
  "ARCHIVED",
]);
export const evidenceUploadStatusSchema = z.enum([
  "CREATED",
  "UPLOADED",
  "STREAMING",
  "INSPECTING",
  "SCANNING",
  "PROMOTING",
  "CONFIRMED",
  "FAILED",
  "EXPIRED",
]);
export const evidenceReviewDecisionSchema = z.enum([
  "ACCEPTED",
  "REJECTED",
  "CONDITIONAL",
]);

export const evidenceArchivePolicySchema = z
  .object({
    maximumEntries: z.number().int().positive().max(1000),
    maximumExpandedBytes: positiveIntegerSchema.max(MAX_EXPANDED_ARCHIVE_BYTES),
    maximumCompressionRatio: z.number().finite().positive().max(100),
  })
  .strict();

export const evidenceRequirementSchema = z
  .object({
    id: z.uuid(),
    code: boundedText(128),
    allowedExtensions: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/)).min(1).max(32),
    allowedMediaTypes: z.array(boundedText(128)).min(1).max(32),
    maximumBytes: positiveIntegerSchema.max(MAX_EVIDENCE_BYTES),
    minimumCount: z.number().int().positive().max(100),
    hardGate: z.boolean(),
    conditionalAdvancement: z.boolean(),
    conditionalFollowUpHours: z.number().int().positive().max(8760),
    archive: evidenceArchivePolicySchema,
  })
  .strict();

export const evidenceRequirementPageSchema = z
  .object({ items: z.array(evidenceRequirementSchema).max(100), ...pageFields })
  .strict();

export const createEvidenceUploadSessionRequestSchema = z
  .object({
    requirementId: z.uuid(),
    targetEntityId: z.uuid(),
    evidenceId: z.uuid().optional(),
    slotKey: boundedText(128),
    extension: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/),
    expectedSha256: sha256Schema,
    expectedSizeBytes: positiveIntegerSchema.max(MAX_EVIDENCE_BYTES),
  })
  .strict();

export const evidenceUploadSessionSchema = z
  .object({
    id: z.uuid(),
    evidenceId: z.uuid(),
    status: evidenceUploadStatusSchema,
    expectedSha256: sha256Schema,
    expectedSizeBytes: positiveIntegerSchema.max(MAX_EVIDENCE_BYTES),
    actualSha256: sha256Schema.optional(),
    actualSizeBytes: positiveIntegerSchema.max(MAX_EVIDENCE_BYTES).optional(),
    detectedMediaType: boundedText(128).optional(),
    failureCode: boundedText(128).optional(),
    createdAt: instantSchema,
    expiresAt: instantSchema,
    version: versionSchema,
  })
  .strict();

export const confirmedEvidenceContentResultSchema = z
  .object({
    uploadSessionId: z.uuid(),
    evidenceId: z.uuid(),
    status: z.literal("CONFIRMED"),
    sha256: sha256Schema,
    sizeBytes: positiveIntegerSchema.max(MAX_EVIDENCE_BYTES),
    detectedMediaType: boundedText(128),
    evidenceVersion: positiveIntegerSchema,
    version: versionSchema,
  })
  .strict();

export const failedEvidenceContentResultSchema = z
  .object({
    uploadSessionId: z.uuid(),
    evidenceId: z.uuid(),
    status: z.literal("FAILED"),
    failureCode: boundedText(128),
    version: versionSchema,
  })
  .strict();

export const evidenceContentResultSchema = z.discriminatedUnion("status", [
  confirmedEvidenceContentResultSchema,
  failedEvidenceContentResultSchema,
]);

export const evidenceMetadataSchema = z
  .object({
    id: z.uuid(),
    requirementId: z.uuid(),
    targetEntityId: z.uuid(),
    slotKey: boundedText(128),
    state: evidenceStateSchema,
    currentVersion: positiveIntegerSchema.optional(),
    version: versionSchema,
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .strict();

export const submitEvidenceRequestSchema = z
  .object({ evidenceVersion: positiveIntegerSchema })
  .strict();

export const evidenceReviewConditionSchema = z
  .object({
    code: boundedText(128),
    detail: boundedText(1024),
  })
  .strict();

export const reviewEvidenceRequestSchema = z
  .object({
    evidenceVersion: positiveIntegerSchema,
    decision: evidenceReviewDecisionSchema,
    reason: boundedText(2048),
    conditions: z.array(evidenceReviewConditionSchema).max(50).optional(),
  })
  .strict()
  .superRefine(({ decision, conditions }, context) => {
    if (decision === "CONDITIONAL" && (!conditions || conditions.length === 0)) {
      context.addIssue({
        code: "custom",
        message: "conditional reviews require at least one condition",
        path: ["conditions"],
      });
    }
    if (decision !== "CONDITIONAL" && conditions !== undefined) {
      context.addIssue({
        code: "custom",
        message: "only conditional reviews may include conditions",
        path: ["conditions"],
      });
    }
  });

export const evidenceVersionSchema = z
  .object({
    id: z.uuid(),
    evidenceId: z.uuid(),
    version: positiveIntegerSchema,
    uploadSessionId: z.uuid(),
    sha256: sha256Schema,
    mediaType: boundedText(128),
    extension: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}$/),
    sizeBytes: positiveIntegerSchema.max(MAX_EVIDENCE_BYTES),
    submittedAt: instantSchema,
  })
  .strict();

export const evidenceReviewSchema = z
  .object({
    id: z.uuid(),
    evidenceId: z.uuid(),
    evidenceVersion: positiveIntegerSchema,
    decision: evidenceReviewDecisionSchema,
    reason: boundedText(2048),
    conditions: z.array(evidenceReviewConditionSchema).max(50),
    followUpDueAt: instantSchema.optional(),
    gateSatisfied: z.boolean(),
    reviewedAt: instantSchema,
  })
  .strict();

export const evidenceVersionPageSchema = z
  .object({ items: z.array(evidenceVersionSchema).max(100), ...pageFields })
  .strict();
export const evidenceReviewPageSchema = z
  .object({ items: z.array(evidenceReviewSchema).max(100), ...pageFields })
  .strict();

export const evidencePreviewMetadataSchema = z
  .object({
    evidenceId: z.uuid(),
    evidenceVersion: positiveIntegerSchema,
    mediaType: boundedText(128),
    sizeBytes: positiveIntegerSchema.max(MAX_EVIDENCE_BYTES),
    generatedAt: instantSchema,
  })
  .strict();

export const evidenceDownloadMetadataSchema = z
  .object({
    evidenceId: z.uuid(),
    evidenceVersion: positiveIntegerSchema,
    filename: boundedText(255),
    mediaType: boundedText(128),
    sizeBytes: positiveIntegerSchema.max(MAX_EVIDENCE_BYTES),
    sha256: sha256Schema,
    disposition: z.literal("attachment"),
  })
  .strict();

export const riskSeveritySchema = z.enum(["INFO", "YELLOW", "RED"]);
export const riskStateSchema = z.enum([
  "OPEN",
  "ACKNOWLEDGED",
  "RESOLVED",
  "DISMISSED",
]);
export const riskActionTypeSchema = z.enum([
  "ACKNOWLEDGED",
  "ASSIGNED",
  "ESCALATED",
  "MITIGATED",
  "RESOLVED",
  "DISMISSED",
]);
export const riskSlaStatusSchema = z.enum(["NOT_DUE", "DUE", "BREACHED", "COMPLETED"]);
export const riskAdjudicationOutcomeSchema = z.enum([
  "TRUE_POSITIVE",
  "FALSE_POSITIVE",
  "MISSED",
  "NOT_APPLICABLE",
]);

export const riskSchema = z
  .object({
    id: z.uuid(),
    ruleDefinitionId: z.uuid(),
    targetEntityId: z.uuid(),
    severity: riskSeveritySchema,
    state: riskStateSchema,
    confidence: z.number().finite().min(0).max(1).optional(),
    reason: boundedText(2048),
    detectedAt: instantSchema,
    evaluatedAt: instantSchema,
    dueAt: instantSchema.optional(),
    ownerRelationshipId: z.uuid().optional(),
    lastEscalationLevel: z.number().int().nonnegative().max(100).optional(),
    resolvedAt: instantSchema.optional(),
    version: versionSchema,
  })
  .strict();

export const riskFiltersSchema = z
  .object({
    severity: z.array(riskSeveritySchema).min(1).max(3).optional(),
    state: z.array(riskStateSchema).min(1).max(4).optional(),
    slaStatus: z.array(riskSlaStatusSchema).min(1).max(4).optional(),
    targetEntityId: z.uuid().optional(),
    ownerRelationshipId: z.uuid().optional(),
    significantOnly: z.boolean().optional(),
    cursor: opaqueCursorSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const riskPageSchema = z
  .object({ items: z.array(riskSchema).max(100), ...pageFields })
  .strict();

export const riskActionSchema = z
  .object({
    id: z.uuid(),
    riskId: z.uuid(),
    action: riskActionTypeSchema,
    escalationLevel: z.number().int().nonnegative().max(100).optional(),
    reason: boundedText(2048).optional(),
    ownerRelationshipId: z.uuid().optional(),
    interventionType: boundedText(128).optional(),
    actedAt: instantSchema,
  })
  .strict();

export const acknowledgeRiskRequestSchema = z.object({ reason: boundedText(2048) }).strict();
export const assignRiskRequestSchema = z
  .object({ ownerRelationshipId: z.uuid(), reason: boundedText(2048) })
  .strict();
export const escalateRiskRequestSchema = z
  .object({
    level: z.number().int().nonnegative().max(100),
    severity: riskSeveritySchema,
    ownerRelationshipId: z.uuid().optional(),
    reason: boundedText(2048),
  })
  .strict();
export const mitigateRiskRequestSchema = z
  .object({ interventionType: boundedText(128), reason: boundedText(2048) })
  .strict();
export const resolveRiskRequestSchema = z.object({ reason: boundedText(2048) }).strict();
export const dismissRiskRequestSchema = z.object({ reason: boundedText(2048) }).strict();

export const riskActionRequestSchemas = {
  acknowledge: acknowledgeRiskRequestSchema,
  assign: assignRiskRequestSchema,
  escalate: escalateRiskRequestSchema,
  mitigate: mitigateRiskRequestSchema,
  resolve: resolveRiskRequestSchema,
  dismiss: dismissRiskRequestSchema,
} as const;

export const acknowledgeRiskActionCommandSchema = acknowledgeRiskRequestSchema
  .extend({ action: z.literal("ACKNOWLEDGE") })
  .strict();
export const assignRiskActionCommandSchema = assignRiskRequestSchema
  .extend({ action: z.literal("ASSIGN") })
  .strict();
export const escalateRiskActionCommandSchema = escalateRiskRequestSchema
  .extend({ action: z.literal("ESCALATE") })
  .strict();
export const mitigateRiskActionCommandSchema = mitigateRiskRequestSchema
  .extend({ action: z.literal("MITIGATE") })
  .strict();
export const resolveRiskActionCommandSchema = resolveRiskRequestSchema
  .extend({ action: z.literal("RESOLVE") })
  .strict();
export const dismissRiskActionCommandSchema = dismissRiskRequestSchema
  .extend({ action: z.literal("DISMISS") })
  .strict();

export const riskActionCommandRequestSchema = z.discriminatedUnion("action", [
  acknowledgeRiskActionCommandSchema,
  assignRiskActionCommandSchema,
  escalateRiskActionCommandSchema,
  mitigateRiskActionCommandSchema,
  resolveRiskActionCommandSchema,
  dismissRiskActionCommandSchema,
]);

export const riskActionPageSchema = z
  .object({ items: z.array(riskActionSchema).max(100), ...pageFields })
  .strict();

export const interventionFiltersSchema = z
  .object({
    severity: z.array(riskSeveritySchema).min(1).max(3).optional(),
    state: z.array(riskStateSchema).min(1).max(4).optional(),
    slaStatus: z.array(riskSlaStatusSchema).min(1).max(4).optional(),
    targetEntityId: z.uuid().optional(),
    ownedByMe: z.boolean().optional(),
    cursor: opaqueCursorSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const interventionItemSchema = z
  .object({
    id: z.uuid(),
    riskId: z.uuid(),
    targetEntityId: z.uuid(),
    interventionType: boundedText(128),
    severity: riskSeveritySchema,
    state: riskStateSchema,
    slaStatus: riskSlaStatusSchema,
    dueAt: instantSchema.optional(),
    ownerRelationshipId: z.uuid().optional(),
    createdAt: instantSchema,
  })
  .strict();

export const interventionPageSchema = z
  .object({ items: z.array(interventionItemSchema).max(100), ...pageFields })
  .strict();

export const createRiskAdjudicationRequestSchema = z
  .object({
    reportingPeriodStart: dateSchema,
    reportingPeriodEnd: dateSchema,
    knownEventKey: boundedText(512),
    targetEntityId: z.uuid(),
    severeEvent: z.boolean(),
    riskId: z.uuid().optional(),
    outcome: riskAdjudicationOutcomeSchema,
    reason: boundedText(2048),
    supersedesAdjudicationId: z.uuid().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.reportingPeriodStart) >= Date.parse(value.reportingPeriodEnd)) {
      context.addIssue({ code: "custom", message: "reporting period end must be later than start", path: ["reportingPeriodEnd"] });
    }
    if (value.outcome === "MISSED" && value.riskId !== undefined) {
      context.addIssue({ code: "custom", message: "missed events cannot link a risk", path: ["riskId"] });
    }
  });

export const riskAdjudicationSchema = z
  .object({
    id: z.uuid(),
    reportingPeriodStart: dateSchema,
    reportingPeriodEnd: dateSchema,
    knownEventKey: boundedText(512),
    targetEntityId: z.uuid(),
    severeEvent: z.boolean(),
    riskId: z.uuid().optional(),
    outcome: riskAdjudicationOutcomeSchema,
    reason: boundedText(2048),
    adjudicationVersion: positiveIntegerSchema,
    supersedesAdjudicationId: z.uuid().optional(),
    createdAt: instantSchema,
  })
  .strict()
  .refine(
    ({ reportingPeriodStart, reportingPeriodEnd }) =>
      Date.parse(reportingPeriodStart) < Date.parse(reportingPeriodEnd),
    { message: "reporting period end must be later than start", path: ["reportingPeriodEnd"] },
  );

export const riskAdjudicationPageSchema = z
  .object({ items: z.array(riskAdjudicationSchema).max(100), ...pageFields })
  .strict();

export const riskMetricsSchema = z
  .object({
    reportingPeriodStart: dateSchema,
    reportingPeriodEnd: dateSchema,
    evaluatedCount: versionSchema,
    severeEventCount: versionSchema,
    truePositiveCount: versionSchema,
    falsePositiveCount: versionSchema,
    missedCount: versionSchema,
    acknowledgedWithinSlaCount: versionSchema,
    resolvedCount: versionSchema,
    generatedAt: instantSchema,
  })
  .strict()
  .refine(
    ({ reportingPeriodStart, reportingPeriodEnd }) =>
      Date.parse(reportingPeriodStart) < Date.parse(reportingPeriodEnd),
    { message: "reporting period end must be later than start", path: ["reportingPeriodEnd"] },
  );

export const riskEvaluationSummarySchema = z
  .object({
    evaluatedAt: instantSchema,
    evaluatedRuleCount: versionSchema,
    openedRiskCount: versionSchema,
    deduplicatedOccurrenceCount: versionSchema,
    escalatedRiskCount: versionSchema,
  })
  .strict();

export const resourceStateSchema = z.enum([
  "AVAILABLE",
  "UNAVAILABLE",
  "MAINTENANCE",
  "ARCHIVED",
]);
export const availabilityModeSchema = z.enum(["AVAILABLE", "UNAVAILABLE"]);
export const reservationStateSchema = z.enum([
  "PENDING",
  "CONFIRMED",
  "CANCELLED",
  "COMPLETED",
]);
export const reservationConflictKindSchema = z.enum([
  "EXCLUSIVE",
  "CAPACITY",
  "UNAVAILABLE",
]);

const resourceDataSchema = z.record(
  z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_.-]*$/),
  z.union([boundedText(512, 0), z.number().finite(), z.boolean(), z.null()]),
);

export const managedResourceSchema = z
  .object({
    id: z.uuid(),
    resourceType: boundedText(128),
    capacity: positiveCapacitySchema,
    state: resourceStateSchema,
    data: resourceDataSchema,
    version: versionSchema,
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .strict();

export const resourceFiltersSchema = z
  .object({
    resourceType: boundedText(128).optional(),
    state: z.array(resourceStateSchema).min(1).max(4).optional(),
    minimumCapacity: positiveCapacitySchema.optional(),
    cursor: opaqueCursorSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

export const managedResourcePageSchema = z
  .object({ items: z.array(managedResourceSchema).max(100), ...pageFields })
  .strict();

export const updateResourceRequestSchema = z
  .object({
    capacity: positiveCapacitySchema.optional(),
    state: resourceStateSchema.optional(),
    data: resourceDataSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "at least one resource field is required");

export const availabilityWindowSchema = z
  .object({
    id: z.uuid(),
    resourceId: z.uuid(),
    interval: halfOpenIntervalSchema,
    mode: availabilityModeSchema,
    reason: boundedText(512).optional(),
    createdAt: instantSchema,
  })
  .strict();

export const createAvailabilityWindowRequestSchema = z
  .object({
    interval: halfOpenIntervalSchema,
    mode: availabilityModeSchema,
    reason: boundedText(512).optional(),
  })
  .strict();

export const availabilityWindowPageSchema = z
  .object({ items: z.array(availabilityWindowSchema).max(100), ...pageFields })
  .strict();

export const redactedReservationConflictDescriptorSchema = z
  .object({
    resourceId: z.uuid(),
    interval: halfOpenIntervalSchema,
    kind: reservationConflictKindSchema,
    redacted: z.literal(true),
  })
  .strict();

export const unredactedReservationConflictDescriptorSchema = z
  .object({
    resourceId: z.uuid(),
    interval: halfOpenIntervalSchema,
    kind: reservationConflictKindSchema,
    redacted: z.literal(false),
    reservationId: z.uuid().optional(),
    requesterEntityId: z.uuid().optional(),
  })
  .strict();

export const reservationConflictSchema = z.discriminatedUnion("redacted", [
  redactedReservationConflictDescriptorSchema,
  unredactedReservationConflictDescriptorSchema,
]);

export const reservationConflictProblemSchema = domainProblemDetailsSchema
  .extend({
    status: z.literal(409),
    code: z.literal("OCC-RESERVATION-CONFLICT"),
    conflict: reservationConflictSchema,
  })
  .strict();

export const resourceUpdateConflictProblemSchema = z.union([
  ...kernelIdempotencyConflictSchemas,
  versionConflictProblemSchema,
  resourceUnavailableProblemSchema,
  reservationConflictProblemSchema,
]);
export const resourceAvailabilityConflictProblemSchema = resourceUpdateConflictProblemSchema;

export const reservationCreateConflictProblemSchema = z.union([
  ...kernelIdempotencyConflictSchemas,
  resourceUnavailableProblemSchema,
  reservationConflictProblemSchema,
]);
export const reservationChangeConflictProblemSchema = z.union([
  ...kernelIdempotencyConflictSchemas,
  versionConflictProblemSchema,
  resourceUnavailableProblemSchema,
  reservationConflictProblemSchema,
]);

export const reservationAvailabilityRequestSchema = z
  .object({
    interval: halfOpenIntervalSchema,
    capacity: positiveCapacitySchema,
    exclusive: z.boolean(),
    excludingReservationId: z.uuid().optional(),
  })
  .strict();

export const reservationAvailabilitySchema = z
  .object({
    resourceId: z.uuid(),
    interval: halfOpenIntervalSchema,
    requestedCapacity: positiveCapacitySchema,
    available: z.boolean(),
    remainingCapacity: z.number().finite().nonnegative().max(MAX_SAFE_VERSION),
    conflicts: z.array(reservationConflictSchema).max(100),
  })
  .strict();

export const reservationSchema = z
  .object({
    id: z.uuid(),
    resourceId: z.uuid(),
    requesterEntityId: z.uuid().optional(),
    processInstanceId: z.uuid().optional(),
    taskId: z.uuid().optional(),
    interval: halfOpenIntervalSchema,
    capacity: positiveCapacitySchema,
    exclusive: z.boolean(),
    state: reservationStateSchema,
    version: versionSchema,
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .strict();

export const reservationScheduleFiltersSchema = z
  .object({
    from: instantSchema,
    until: instantSchema,
    state: z.array(reservationStateSchema).min(1).max(4).optional(),
    cursor: opaqueCursorSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict()
  .refine(({ from, until }) => Date.parse(from) < Date.parse(until), { path: ["until"], message: "until must be later than from" });

export const reservationSchedulePageSchema = z
  .object({ items: z.array(reservationSchema).max(100), ...pageFields })
  .strict();

export const reserveResourceRequestSchema = z
  .object({
    resourceId: z.uuid(),
    requesterEntityId: z.uuid(),
    processInstanceId: z.uuid().optional(),
    taskId: z.uuid().optional(),
    interval: halfOpenIntervalSchema,
    capacity: positiveCapacitySchema,
    exclusive: z.boolean(),
  })
  .strict();

export const changeReservationRequestSchema = z
  .object({
    interval: halfOpenIntervalSchema,
    capacity: positiveCapacitySchema,
    exclusive: z.boolean(),
  })
  .strict();

export const cancelReservationRequestSchema = z
  .object({ reason: boundedText(512) })
  .strict();

const eventReasonCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);

export const DOMAIN_EVENT_TYPES = [
  "EVIDENCE_UPLOAD_FAILED",
  "EVIDENCE_UPLOAD_CONFIRMED",
  "EVIDENCE_SUBMITTED",
  "EVIDENCE_REVIEWED",
  "RISK_OPENED",
  "RISK_ACTIONED",
  "RISK_ESCALATED",
  "RISK_RESOLVED",
  "RISK_DISMISSED",
  "RESOURCE_AVAILABILITY_CHANGED",
  "RESERVATION_CREATED",
  "RESERVATION_CHANGED",
  "RESERVATION_CANCELLED",
  "RESERVATION_CONFLICTED",
] as const;

export const domainEventTypeSchema = z.enum(DOMAIN_EVENT_TYPES);

export const evidenceEventPayloadSchema = z
  .object({
    evidenceId: z.uuid(),
    uploadSessionId: z.uuid().optional(),
    state: evidenceStateSchema,
    version: versionSchema,
    evidenceVersion: positiveIntegerSchema.optional(),
    decision: evidenceReviewDecisionSchema.optional(),
    reasonCode: eventReasonCodeSchema.optional(),
  })
  .strict();

export const riskEventPayloadSchema = z
  .object({
    riskId: z.uuid(),
    state: riskStateSchema,
    severity: riskSeveritySchema,
    version: versionSchema,
    action: riskActionTypeSchema.optional(),
    escalationLevel: z.number().int().nonnegative().max(100).optional(),
    reasonCode: eventReasonCodeSchema.optional(),
  })
  .strict();

export const resourceEventPayloadSchema = z
  .object({
    resourceId: z.uuid(),
    state: resourceStateSchema,
    version: versionSchema,
    interval: halfOpenIntervalSchema.optional(),
    capacity: positiveCapacitySchema.optional(),
    availabilityMode: availabilityModeSchema.optional(),
    reasonCode: eventReasonCodeSchema.optional(),
  })
  .strict();

export const reservationEventPayloadSchema = z
  .object({
    reservationId: z.uuid(),
    resourceId: z.uuid(),
    state: reservationStateSchema,
    version: versionSchema,
    interval: halfOpenIntervalSchema,
    capacity: positiveCapacitySchema,
    exclusive: z.boolean(),
    conflictKind: reservationConflictKindSchema.optional(),
    reasonCode: eventReasonCodeSchema.optional(),
  })
  .strict();

const domainEventEnvelope = <T extends string, P extends z.ZodType>(
  type: T,
  payload: P,
) =>
  z
    .object({
      id: z.uuid(),
      customerInstanceId: z.uuid(),
      type: z.literal(type),
      schemaVersion: positiveIntegerSchema,
      aggregateType: boundedText(256),
      aggregateId: z.uuid(),
      aggregateVersion: versionSchema,
      occurredAt: instantSchema,
      actorId: z.uuid().optional(),
      correlationId: z.uuid(),
      causationId: z.uuid().optional(),
      payload,
    })
    .strict();

export const domainEventEnvelopeSchema = z.discriminatedUnion("type", [
  domainEventEnvelope("EVIDENCE_UPLOAD_FAILED", evidenceEventPayloadSchema),
  domainEventEnvelope("EVIDENCE_UPLOAD_CONFIRMED", evidenceEventPayloadSchema),
  domainEventEnvelope("EVIDENCE_SUBMITTED", evidenceEventPayloadSchema),
  domainEventEnvelope("EVIDENCE_REVIEWED", evidenceEventPayloadSchema),
  domainEventEnvelope("RISK_OPENED", riskEventPayloadSchema),
  domainEventEnvelope("RISK_ACTIONED", riskEventPayloadSchema),
  domainEventEnvelope("RISK_ESCALATED", riskEventPayloadSchema),
  domainEventEnvelope("RISK_RESOLVED", riskEventPayloadSchema),
  domainEventEnvelope("RISK_DISMISSED", riskEventPayloadSchema),
  domainEventEnvelope("RESOURCE_AVAILABILITY_CHANGED", resourceEventPayloadSchema),
  domainEventEnvelope("RESERVATION_CREATED", reservationEventPayloadSchema),
  domainEventEnvelope("RESERVATION_CHANGED", reservationEventPayloadSchema),
  domainEventEnvelope("RESERVATION_CANCELLED", reservationEventPayloadSchema),
  domainEventEnvelope("RESERVATION_CONFLICTED", reservationEventPayloadSchema),
]);

export type OpaqueCursor = z.infer<typeof opaqueCursorSchema>;
export type EvidenceRangeHeader = z.infer<typeof evidenceRangeHeaderSchema>;
export type EvidenceContentRangeHeader = z.infer<typeof evidenceContentRangeHeaderSchema>;
export type EvidenceUnsatisfiedContentRangeHeader = z.infer<typeof evidenceUnsatisfiedContentRangeHeaderSchema>;
export type DomainProblemDetails = z.infer<typeof domainProblemDetailsSchema>;
export type EvidenceUploadConflictProblem = z.infer<typeof evidenceUploadConflictProblemSchema>;
export type EvidenceReviewConflictProblem = z.infer<typeof evidenceReviewConflictProblemSchema>;
export type RiskInvalidTransitionProblem = z.infer<typeof riskInvalidTransitionProblemSchema>;
export type ResourceUnavailableProblem = z.infer<typeof resourceUnavailableProblemSchema>;
export type ReservationConflictProblem = z.infer<typeof reservationConflictProblemSchema>;
export type IdempotencyConflictProblem = z.infer<typeof idempotencyConflictProblemSchema>;
export type IdempotencyInProgressProblem = z.infer<typeof idempotencyInProgressProblemSchema>;
export type IdempotencyExpiredProblem = z.infer<typeof idempotencyExpiredProblemSchema>;
export type VersionConflictProblem = z.infer<typeof versionConflictProblemSchema>;
export type AuthorizationUnavailableProblem = z.infer<typeof authorizationUnavailableProblemSchema>;
export type CommandIntegrityProblem = z.infer<typeof commandIntegrityProblemSchema>;
export type RiskAdjudicationConflictProblem = z.infer<typeof riskAdjudicationConflictProblemSchema>;
export type EvidenceUploadSessionConflictProblem = z.infer<typeof evidenceUploadSessionConflictProblemSchema>;
export type EvidenceContentConflictProblem = z.infer<typeof evidenceContentConflictProblemSchema>;
export type EvidenceSubmitConflictProblem = z.infer<typeof evidenceSubmitConflictProblemSchema>;
export type EvidenceReviewCommandConflictProblem = z.infer<typeof evidenceReviewCommandConflictProblemSchema>;
export type RiskActionConflictProblem = z.infer<typeof riskActionConflictProblemSchema>;
export type ResourceUpdateConflictProblem = z.infer<typeof resourceUpdateConflictProblemSchema>;
export type ResourceAvailabilityConflictProblem = z.infer<typeof resourceAvailabilityConflictProblemSchema>;
export type ReservationCreateConflictProblem = z.infer<typeof reservationCreateConflictProblemSchema>;
export type ReservationChangeConflictProblem = z.infer<typeof reservationChangeConflictProblemSchema>;
export type ReservationCancelConflictProblem = z.infer<typeof reservationCancelConflictProblemSchema>;
export type ProtectedCommandUnavailableProblem = z.infer<typeof protectedCommandUnavailableProblemSchema>;
export type EvidenceTooLargeProblem = z.infer<typeof evidenceTooLargeProblemSchema>;
export type EvidenceDigestMismatchProblem = z.infer<typeof evidenceDigestMismatchProblemSchema>;
export type EvidenceInvalidContentProblem = z.infer<typeof evidenceInvalidContentProblemSchema>;
export type UnprocessableContentProblem = z.infer<typeof unprocessableContentProblemSchema>;
export type InvalidRangeProblem = z.infer<typeof invalidRangeProblemSchema>;
export type EvidenceState = z.infer<typeof evidenceStateSchema>;
export type EvidenceUploadStatus = z.infer<typeof evidenceUploadStatusSchema>;
export type EvidenceReviewDecision = z.infer<typeof evidenceReviewDecisionSchema>;
export type EvidenceArchivePolicy = z.infer<typeof evidenceArchivePolicySchema>;
export type EvidenceRequirement = z.infer<typeof evidenceRequirementSchema>;
export type EvidenceRequirementPage = z.infer<typeof evidenceRequirementPageSchema>;
export type CreateEvidenceUploadSessionRequest = z.infer<typeof createEvidenceUploadSessionRequestSchema>;
export type EvidenceUploadSession = z.infer<typeof evidenceUploadSessionSchema>;
export type EvidenceContentResult = z.infer<typeof evidenceContentResultSchema>;
export type ConfirmedEvidenceContentResult = z.infer<typeof confirmedEvidenceContentResultSchema>;
export type FailedEvidenceContentResult = z.infer<typeof failedEvidenceContentResultSchema>;
export type EvidenceMetadata = z.infer<typeof evidenceMetadataSchema>;
export type SubmitEvidenceRequest = z.infer<typeof submitEvidenceRequestSchema>;
export type EvidenceReviewCondition = z.infer<typeof evidenceReviewConditionSchema>;
export type ReviewEvidenceRequest = z.infer<typeof reviewEvidenceRequestSchema>;
export type EvidenceVersion = z.infer<typeof evidenceVersionSchema>;
export type EvidenceReview = z.infer<typeof evidenceReviewSchema>;
export type EvidenceVersionPage = z.infer<typeof evidenceVersionPageSchema>;
export type EvidenceReviewPage = z.infer<typeof evidenceReviewPageSchema>;
export type EvidencePreviewMetadata = z.infer<typeof evidencePreviewMetadataSchema>;
export type EvidenceDownloadMetadata = z.infer<typeof evidenceDownloadMetadataSchema>;
export type RiskSeverity = z.infer<typeof riskSeveritySchema>;
export type RiskState = z.infer<typeof riskStateSchema>;
export type RiskActionType = z.infer<typeof riskActionTypeSchema>;
export type RiskSlaStatus = z.infer<typeof riskSlaStatusSchema>;
export type RiskAdjudicationOutcome = z.infer<typeof riskAdjudicationOutcomeSchema>;
export type Risk = z.infer<typeof riskSchema>;
export type RiskFilters = z.infer<typeof riskFiltersSchema>;
export type RiskPage = z.infer<typeof riskPageSchema>;
export type RiskAction = z.infer<typeof riskActionSchema>;
export type AcknowledgeRiskRequest = z.infer<typeof acknowledgeRiskRequestSchema>;
export type AssignRiskRequest = z.infer<typeof assignRiskRequestSchema>;
export type EscalateRiskRequest = z.infer<typeof escalateRiskRequestSchema>;
export type MitigateRiskRequest = z.infer<typeof mitigateRiskRequestSchema>;
export type ResolveRiskRequest = z.infer<typeof resolveRiskRequestSchema>;
export type DismissRiskRequest = z.infer<typeof dismissRiskRequestSchema>;
export type RiskActionCommandRequest = z.infer<typeof riskActionCommandRequestSchema>;
export type AcknowledgeRiskActionCommand = z.infer<typeof acknowledgeRiskActionCommandSchema>;
export type AssignRiskActionCommand = z.infer<typeof assignRiskActionCommandSchema>;
export type EscalateRiskActionCommand = z.infer<typeof escalateRiskActionCommandSchema>;
export type MitigateRiskActionCommand = z.infer<typeof mitigateRiskActionCommandSchema>;
export type ResolveRiskActionCommand = z.infer<typeof resolveRiskActionCommandSchema>;
export type DismissRiskActionCommand = z.infer<typeof dismissRiskActionCommandSchema>;
export type RiskActionPage = z.infer<typeof riskActionPageSchema>;
export type InterventionFilters = z.infer<typeof interventionFiltersSchema>;
export type InterventionItem = z.infer<typeof interventionItemSchema>;
export type InterventionPage = z.infer<typeof interventionPageSchema>;
export type CreateRiskAdjudicationRequest = z.infer<typeof createRiskAdjudicationRequestSchema>;
export type RiskAdjudication = z.infer<typeof riskAdjudicationSchema>;
export type RiskAdjudicationPage = z.infer<typeof riskAdjudicationPageSchema>;
export type RiskMetrics = z.infer<typeof riskMetricsSchema>;
export type RiskEvaluationSummary = z.infer<typeof riskEvaluationSummarySchema>;
export type ResourceState = z.infer<typeof resourceStateSchema>;
export type AvailabilityMode = z.infer<typeof availabilityModeSchema>;
export type ReservationState = z.infer<typeof reservationStateSchema>;
export type ReservationConflictKind = z.infer<typeof reservationConflictKindSchema>;
export type ManagedResource = z.infer<typeof managedResourceSchema>;
export type ResourceFilters = z.infer<typeof resourceFiltersSchema>;
export type ManagedResourcePage = z.infer<typeof managedResourcePageSchema>;
export type UpdateResourceRequest = z.infer<typeof updateResourceRequestSchema>;
export type AvailabilityWindow = z.infer<typeof availabilityWindowSchema>;
export type CreateAvailabilityWindowRequest = z.infer<typeof createAvailabilityWindowRequestSchema>;
export type AvailabilityWindowPage = z.infer<typeof availabilityWindowPageSchema>;
export type Reservation = z.infer<typeof reservationSchema>;
export type ReservationConflict = z.infer<typeof reservationConflictSchema>;
export type RedactedReservationConflictDescriptor = z.infer<typeof redactedReservationConflictDescriptorSchema>;
export type UnredactedReservationConflictDescriptor = z.infer<typeof unredactedReservationConflictDescriptorSchema>;
export type ReservationAvailabilityRequest = z.infer<typeof reservationAvailabilityRequestSchema>;
export type ReservationAvailability = z.infer<typeof reservationAvailabilitySchema>;
export type ReservationScheduleFilters = z.infer<typeof reservationScheduleFiltersSchema>;
export type ReservationSchedulePage = z.infer<typeof reservationSchedulePageSchema>;
export type ReserveResourceRequest = z.infer<typeof reserveResourceRequestSchema>;
export type ChangeReservationRequest = z.infer<typeof changeReservationRequestSchema>;
export type CancelReservationRequest = z.infer<typeof cancelReservationRequestSchema>;
export type EvidenceEventPayload = z.infer<typeof evidenceEventPayloadSchema>;
export type RiskEventPayload = z.infer<typeof riskEventPayloadSchema>;
export type ResourceEventPayload = z.infer<typeof resourceEventPayloadSchema>;
export type ReservationEventPayload = z.infer<typeof reservationEventPayloadSchema>;
export type DomainEventType = z.infer<typeof domainEventTypeSchema>;
export type DomainEventEnvelope = z.infer<typeof domainEventEnvelopeSchema>;
