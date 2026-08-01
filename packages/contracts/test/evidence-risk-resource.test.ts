import { describe, expect, it } from "vitest";

import {
  MAX_EVIDENCE_BYTES,
  availabilityWindowSchema,
  cancelReservationRequestSchema,
  changeReservationRequestSchema,
  createEvidenceUploadSessionRequestSchema,
  createRiskAdjudicationRequestSchema,
  evidenceContentResultSchema,
  evidenceDownloadMetadataSchema,
  evidenceEventPayloadSchema,
  evidenceMetadataSchema,
  evidencePreviewMetadataSchema,
  evidenceRequirementSchema,
  evidenceReviewPageSchema,
  evidenceUploadSessionSchema,
  evidenceVersionPageSchema,
  halfOpenIntervalSchema,
  interventionFiltersSchema,
  interventionPageSchema,
  managedResourceSchema,
  opaqueCursorSchema,
  reservationAvailabilityRequestSchema,
  reservationAvailabilitySchema,
  reservationConflictSchema,
  reservationEventPayloadSchema,
  reservationSchedulePageSchema,
  reservationSchema,
  reserveResourceRequestSchema,
  reviewEvidenceRequestSchema,
  riskActionPageSchema,
  riskActionCommandRequestSchema,
  riskActionRequestSchemas,
  riskAdjudicationPageSchema,
  riskEventPayloadSchema,
  riskFiltersSchema,
  riskMetricsSchema,
  riskPageSchema,
  riskSchema,
  submitEvidenceRequestSchema,
  updateResourceRequestSchema,
} from "../src/evidence-risk-resource.js";

const UUID = "11111111-1111-4111-8111-111111111111";
const UUID_2 = "22222222-2222-4222-8222-222222222222";
const INSTANT = "2026-08-01T10:30:00+02:00";
const LATER = "2026-08-01T11:30:00+02:00";
const SHA256 = "a".repeat(64);

const expectUnknownFieldRejected = (
  schema: { safeParse: (input: unknown) => { success: boolean } },
  value: Record<string, unknown>,
): void => {
  expect(schema.safeParse({ ...value, unexpected: true }).success).toBe(false);
};

describe("evidence contracts", () => {
  const requirement = {
    id: UUID,
    code: "signed-plan",
    allowedExtensions: ["pdf"],
    allowedMediaTypes: ["application/pdf"],
    maximumBytes: MAX_EVIDENCE_BYTES,
    minimumCount: 1,
    hardGate: true,
    conditionalAdvancement: false,
    conditionalFollowUpHours: 48,
    archive: {
      maximumEntries: 1000,
      maximumExpandedBytes: MAX_EVIDENCE_BYTES * 2,
      maximumCompressionRatio: 100,
    },
  };

  it("accepts a bounded requirement and rejects unknown fields", () => {
    expect(evidenceRequirementSchema.parse(requirement)).toEqual(requirement);
    expectUnknownFieldRejected(evidenceRequirementSchema, requirement);
    expect(
      evidenceRequirementSchema.safeParse({
        ...requirement,
        maximumBytes: MAX_EVIDENCE_BYTES + 1,
      }).success,
    ).toBe(false);
    expect(
      evidenceRequirementSchema.safeParse({
        ...requirement,
        archive: { ...requirement.archive, credentials: "secret" },
      }).success,
    ).toBe(false);
  });

  it("requires UUIDs, lowercase SHA-256, bounded sizes, and safe versions", () => {
    const request = {
      requirementId: UUID,
      targetEntityId: UUID_2,
      evidenceId: UUID,
      slotKey: "primary",
      extension: "pdf",
      expectedSha256: SHA256,
      expectedSizeBytes: MAX_EVIDENCE_BYTES,
    };
    expect(createEvidenceUploadSessionRequestSchema.safeParse(request).success).toBe(true);
    expectUnknownFieldRejected(createEvidenceUploadSessionRequestSchema, request);
    expect(
      createEvidenceUploadSessionRequestSchema.safeParse({ ...request, expectedSha256: "A".repeat(64) })
        .success,
    ).toBe(false);
    expect(
      createEvidenceUploadSessionRequestSchema.safeParse({ ...request, expectedSizeBytes: 0 })
        .success,
    ).toBe(false);
    expect(
      createEvidenceUploadSessionRequestSchema.safeParse({ ...request, expectedSizeBytes: MAX_EVIDENCE_BYTES + 1 })
        .success,
    ).toBe(false);
  });

  it("defines strict session, content, metadata, submit, review, and delivery surfaces", () => {
    const session = {
      id: UUID,
      evidenceId: UUID_2,
      status: "CONFIRMED",
      expectedSha256: SHA256,
      expectedSizeBytes: 25,
      actualSha256: SHA256,
      actualSizeBytes: 25,
      detectedMediaType: "application/pdf",
      createdAt: INSTANT,
      expiresAt: LATER,
      version: 1,
    };
    const content = {
      uploadSessionId: UUID,
      evidenceId: UUID_2,
      status: "CONFIRMED",
      sha256: SHA256,
      sizeBytes: 25,
      detectedMediaType: "application/pdf",
      evidenceVersion: 1,
      version: 2,
    };
    const metadata = {
      id: UUID,
      requirementId: UUID_2,
      targetEntityId: UUID,
      slotKey: "primary",
      state: "SUBMITTED",
      currentVersion: 1,
      version: 2,
      createdAt: INSTANT,
      updatedAt: LATER,
    };
    expect(evidenceUploadSessionSchema.safeParse(session).success).toBe(true);
    expect(evidenceContentResultSchema.safeParse(content).success).toBe(true);
    expect(evidenceMetadataSchema.safeParse(metadata).success).toBe(true);
    expect(submitEvidenceRequestSchema.parse({ evidenceVersion: 1 })).toEqual({ evidenceVersion: 1 });
    expect(
      reviewEvidenceRequestSchema.safeParse({
        evidenceVersion: 1,
        decision: "CONDITIONAL",
        reason: "One signature remains.",
        conditions: [{ code: "ADD_SIGNATURE", detail: "Obtain the second signature." }],
      }).success,
    ).toBe(true);
    expect(evidencePreviewMetadataSchema.safeParse({
      evidenceId: UUID,
      evidenceVersion: 1,
      mediaType: "application/pdf",
      sizeBytes: 25,
      generatedAt: INSTANT,
    }).success).toBe(true);
    expect(evidenceDownloadMetadataSchema.safeParse({
      evidenceId: UUID,
      evidenceVersion: 1,
      filename: "evidence.pdf",
      mediaType: "application/pdf",
      sizeBytes: 25,
      sha256: SHA256,
      disposition: "attachment",
    }).success).toBe(true);
    expectUnknownFieldRejected(evidenceMetadataSchema, metadata);
  });

  it("uses opaque cursor pages for immutable version and review history", () => {
    expect(opaqueCursorSchema.safeParse("eyJ2IjoxfQ.sig_-123").success).toBe(true);
    expect(opaqueCursorSchema.safeParse("raw offset 20").success).toBe(false);
    expect(evidenceVersionPageSchema.safeParse({ items: [], nextCursor: "opaque_123" }).success).toBe(true);
    expect(evidenceReviewPageSchema.safeParse({ items: [], previousCursor: "opaque_456" }).success).toBe(true);
  });
});

describe("risk and intervention contracts", () => {
  const risk = {
    id: UUID,
    ruleDefinitionId: UUID_2,
    targetEntityId: UUID,
    severity: "RED",
    state: "OPEN",
    confidence: 0.75,
    reason: "Critical work is overdue.",
    detectedAt: INSTANT,
    evaluatedAt: INSTANT,
    dueAt: LATER,
    version: 0,
  };

  it("enforces risk states, severity, instants, and filters", () => {
    expect(riskSchema.safeParse(risk).success).toBe(true);
    expectUnknownFieldRejected(riskSchema, risk);
    expect(riskSchema.safeParse({ ...risk, severity: "CRITICAL" }).success).toBe(false);
    expect(riskSchema.safeParse({ ...risk, state: "CLOSED" }).success).toBe(false);
    expect(riskSchema.safeParse({ ...risk, detectedAt: "2026-08-01T08:30:00" }).success).toBe(false);
    expect(riskFiltersSchema.safeParse({ severity: ["YELLOW", "RED"], state: ["OPEN"], limit: 50 }).success).toBe(true);
    expect(interventionFiltersSchema.safeParse({ slaStatus: ["DUE", "BREACHED"], ownedByMe: true }).success).toBe(true);
    expect(riskPageSchema.safeParse({ items: [risk], nextCursor: "opaque_123" }).success).toBe(true);
  });

  it("defines every versioned risk command and immutable action history", () => {
    const requests = [
      [riskActionRequestSchemas.acknowledge, { reason: "Taking ownership." }],
      [riskActionRequestSchemas.assign, { ownerRelationshipId: UUID_2, reason: "Assigned to course owner." }],
      [riskActionRequestSchemas.escalate, { level: 1, severity: "RED", reason: "SLA reached." }],
      [riskActionRequestSchemas.mitigate, { interventionType: "COACHING", reason: "Coaching booked." }],
      [riskActionRequestSchemas.resolve, { reason: "Critical work completed." }],
      [riskActionRequestSchemas.dismiss, { reason: "Trigger facts were invalid." }],
    ] as const;
    for (const [schema, request] of requests) {
      expect(schema.safeParse(request).success).toBe(true);
      expectUnknownFieldRejected(schema, request);
    }
    expect(riskActionCommandRequestSchema.safeParse({ action: "ESCALATE", level: 1, severity: "RED", reason: "SLA reached." }).success).toBe(true);
    expect(riskActionCommandRequestSchema.safeParse({ action: "ESCALATE", reason: "Missing required fields." }).success).toBe(false);
    expect(riskActionPageSchema.safeParse({ items: [], nextCursor: "opaque_123" }).success).toBe(true);
    expect(interventionPageSchema.safeParse({ items: [], nextCursor: "opaque_123" }).success).toBe(true);
  });

  it("defines adjudication history and reproducible metrics", () => {
    const request = {
      reportingPeriodStart: "2026-07-01",
      reportingPeriodEnd: "2026-08-01",
      knownEventKey: "critical-overdue:42",
      targetEntityId: UUID,
      severeEvent: true,
      riskId: UUID_2,
      outcome: "TRUE_POSITIVE",
      reason: "Matched the reviewed severe event.",
      supersedesAdjudicationId: UUID,
    };
    expect(createRiskAdjudicationRequestSchema.safeParse(request).success).toBe(true);
    expectUnknownFieldRejected(createRiskAdjudicationRequestSchema, request);
    expect(riskAdjudicationPageSchema.safeParse({ items: [], nextCursor: "opaque_123" }).success).toBe(true);
    expect(riskMetricsSchema.safeParse({
      reportingPeriodStart: "2026-07-01",
      reportingPeriodEnd: "2026-08-01",
      evaluatedCount: 20,
      severeEventCount: 4,
      truePositiveCount: 2,
      falsePositiveCount: 1,
      missedCount: 1,
      acknowledgedWithinSlaCount: 2,
      resolvedCount: 2,
      generatedAt: INSTANT,
    }).success).toBe(true);
  });
});

describe("resource and reservation contracts", () => {
  const interval = { start: INSTANT, end: LATER };
  const resource = {
    id: UUID,
    resourceType: "ROOM",
    capacity: 12,
    state: "AVAILABLE",
    data: { campus: "north" },
    version: 0,
    createdAt: INSTANT,
    updatedAt: INSTANT,
  };

  it("requires positive half-open intervals and capacity", () => {
    expect(halfOpenIntervalSchema.safeParse(interval).success).toBe(true);
    expect(halfOpenIntervalSchema.safeParse({ start: INSTANT, end: INSTANT }).success).toBe(false);
    expect(halfOpenIntervalSchema.safeParse({ start: LATER, end: INSTANT }).success).toBe(false);
    expect(halfOpenIntervalSchema.safeParse({ ...interval, endInclusive: true }).success).toBe(false);
    expect(managedResourceSchema.safeParse(resource).success).toBe(true);
    expect(managedResourceSchema.safeParse({ ...resource, capacity: 0 }).success).toBe(false);
    expect(updateResourceRequestSchema.safeParse({ capacity: 10, state: "MAINTENANCE", data: {} }).success).toBe(true);
  });

  it("defines availability, schedule, conflict, reserve, change, and cancel surfaces", () => {
    expect(availabilityWindowSchema.safeParse({ id: UUID, resourceId: UUID_2, interval, mode: "UNAVAILABLE", reason: "Maintenance", createdAt: INSTANT }).success).toBe(true);
    expect(reservationAvailabilityRequestSchema.safeParse({ interval, capacity: 2, exclusive: false }).success).toBe(true);
    expect(reservationAvailabilitySchema.safeParse({ resourceId: UUID, interval, requestedCapacity: 2, available: true, remainingCapacity: 10, conflicts: [] }).success).toBe(true);
    expect(reservationConflictSchema.safeParse({ resourceId: UUID, interval, kind: "CAPACITY", redacted: true }).success).toBe(true);
    expect(reservationSchedulePageSchema.safeParse({ items: [], nextCursor: "opaque_123" }).success).toBe(true);
    expect(reserveResourceRequestSchema.safeParse({ resourceId: UUID, requesterEntityId: UUID_2, interval, capacity: 2, exclusive: false }).success).toBe(true);
    expect(changeReservationRequestSchema.safeParse({ interval, capacity: 3, exclusive: false }).success).toBe(true);
    expect(cancelReservationRequestSchema.safeParse({ reason: "No longer required." }).success).toBe(true);
    expect(reservationSchema.safeParse({ id: UUID, resourceId: UUID_2, interval, capacity: 2, exclusive: false, state: "CONFIRMED", version: 1, createdAt: INSTANT, updatedAt: LATER }).success).toBe(true);
  });
});

describe("bounded event payload contracts", () => {
  it("contains only bounded domain facts and rejects sensitive fields", () => {
    const interval = { start: INSTANT, end: LATER };
    const evidencePayload = { evidenceId: UUID, state: "SUBMITTED", version: 2, evidenceVersion: 1, reasonCode: "SUBMITTED" };
    const riskPayload = { riskId: UUID, state: "OPEN", severity: "RED", version: 1, action: "ESCALATED", reasonCode: "SLA_BREACH" };
    const reservationPayload = { reservationId: UUID, resourceId: UUID_2, state: "CONFIRMED", version: 1, interval, capacity: 2, exclusive: false, reasonCode: "CREATED" };
    expect(evidenceEventPayloadSchema.safeParse(evidencePayload).success).toBe(true);
    expect(riskEventPayloadSchema.safeParse(riskPayload).success).toBe(true);
    expect(reservationEventPayloadSchema.safeParse(reservationPayload).success).toBe(true);
    for (const forbidden of ["bytes", "objectKey", "credentials", "actorName", "token"]) {
      expect(evidenceEventPayloadSchema.safeParse({ ...evidencePayload, [forbidden]: "secret" }).success).toBe(false);
      expect(riskEventPayloadSchema.safeParse({ ...riskPayload, [forbidden]: "secret" }).success).toBe(false);
      expect(reservationEventPayloadSchema.safeParse({ ...reservationPayload, [forbidden]: "secret" }).success).toBe(false);
    }
  });
});
