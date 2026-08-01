import { z } from "zod";

import { sha256Schema, stableAiErrorCodeSchema, uuidSchema } from "./governed-ai.js";

export const EVENT_TYPE_MIN_LENGTH = 1;
export const EVENT_TYPE_MAX_LENGTH = 256;
export const EVENT_SCHEMA_VERSION_MIN = 1;
export const EVENT_SCHEMA_VERSION_MAX = Number.MAX_SAFE_INTEGER;
export const EVENT_AGGREGATE_TYPE_MIN_LENGTH = 1;
export const EVENT_AGGREGATE_TYPE_MAX_LENGTH = 256;
export const EVENT_AGGREGATE_VERSION_MIN = 0;
export const EVENT_AGGREGATE_VERSION_MAX = Number.MAX_SAFE_INTEGER;
export const EVENT_OCCURRED_AT_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$";

export const eventEnvelopeSchema = z
  .object({
    id: z.uuid(),
    customerInstanceId: z.uuid(),
    type: z.string().min(EVENT_TYPE_MIN_LENGTH).max(EVENT_TYPE_MAX_LENGTH),
    schemaVersion: z
      .number()
      .int()
      .min(EVENT_SCHEMA_VERSION_MIN)
      .max(EVENT_SCHEMA_VERSION_MAX),
    aggregateType: z
      .string()
      .min(EVENT_AGGREGATE_TYPE_MIN_LENGTH)
      .max(EVENT_AGGREGATE_TYPE_MAX_LENGTH),
    aggregateId: z.uuid(),
    aggregateVersion: z
      .number()
      .int()
      .min(EVENT_AGGREGATE_VERSION_MIN)
      .max(EVENT_AGGREGATE_VERSION_MAX),
    occurredAt: z
      .iso.datetime({ offset: true })
      .regex(new RegExp(EVENT_OCCURRED_AT_PATTERN)),
    actorId: z.uuid().optional(),
    correlationId: z.uuid(),
    causationId: z.uuid().optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

export const knowledgeIngestionRequestedPayloadSchema = z
  .object({
    operationId: uuidSchema,
    ingestionJobId: uuidSchema,
    sourceId: uuidSchema,
    documentId: uuidSchema,
    candidateEmbeddingSpaceId: uuidSchema,
    sourceVersion: z.string().min(1).max(256),
    sourceObjectHash: sha256Schema,
  })
  .strict();

export const aiGuidanceRequestedPayloadSchema = z
  .object({
    operationId: uuidSchema,
  })
  .strict();

export const aiRecommendationProposedPayloadSchema = z
  .object({
    operationId: uuidSchema,
    recommendationId: uuidSchema,
    runId: uuidSchema,
  })
  .strict();

export const aiOperationDeadLetteredPayloadSchema = z
  .object({
    operationId: uuidSchema,
    failedEventId: uuidSchema,
    failedEventType: z.string().min(1).max(EVENT_TYPE_MAX_LENGTH),
    attempts: z.number().int().min(1).max(100),
    errorCode: stableAiErrorCodeSchema,
  })
  .strict();

const versionedEventSchema = <
  Type extends string,
  AggregateType extends string,
  Payload extends z.ZodType,
>(type: Type, aggregateType: AggregateType, payload: Payload) =>
  z
    .object({
      ...eventEnvelopeSchema.shape,
      type: z.literal(type),
      schemaVersion: z.literal(1),
      aggregateType: z.literal(aggregateType),
      payload,
    })
    .strict();

export const knowledgeIngestionRequestedEventSchema = versionedEventSchema(
  "knowledge.ingestion-requested.v1",
  "KnowledgeDocument",
  knowledgeIngestionRequestedPayloadSchema,
);
export const aiGuidanceRequestedEventSchema = versionedEventSchema(
  "ai.guidance-requested.v1",
  "AiGuidanceOperation",
  aiGuidanceRequestedPayloadSchema,
);
export const aiRecommendationProposedEventSchema = versionedEventSchema(
  "ai.recommendation-proposed.v1",
  "AiRecommendation",
  aiRecommendationProposedPayloadSchema,
);
export const aiOperationDeadLetteredEventSchema = versionedEventSchema(
  "ai.operation-dead-lettered.v1",
  "AiGuidanceOperation",
  aiOperationDeadLetteredPayloadSchema,
);
export const governedAiEventSchema = z.discriminatedUnion("type", [
  knowledgeIngestionRequestedEventSchema,
  aiGuidanceRequestedEventSchema,
  aiRecommendationProposedEventSchema,
  aiOperationDeadLetteredEventSchema,
]);

export type KnowledgeIngestionRequestedPayload = z.infer<typeof knowledgeIngestionRequestedPayloadSchema>;
export type AiGuidanceRequestedPayload = z.infer<typeof aiGuidanceRequestedPayloadSchema>;
export type AiRecommendationProposedPayload = z.infer<typeof aiRecommendationProposedPayloadSchema>;
export type AiOperationDeadLetteredPayload = z.infer<typeof aiOperationDeadLetteredPayloadSchema>;
export type GovernedAiEvent = z.infer<typeof governedAiEventSchema>;
