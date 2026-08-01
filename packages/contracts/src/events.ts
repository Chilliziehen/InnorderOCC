import { z } from "zod";

export const EVENT_TYPE_MIN_LENGTH = 1;
export const EVENT_TYPE_MAX_LENGTH = 256;
export const EVENT_SCHEMA_VERSION_MIN = 1;
export const EVENT_SCHEMA_VERSION_MAX = Number.MAX_SAFE_INTEGER;
export const EVENT_AGGREGATE_TYPE_MIN_LENGTH = 1;
export const EVENT_AGGREGATE_TYPE_MAX_LENGTH = 256;
export const EVENT_AGGREGATE_VERSION_MIN = 0;
export const EVENT_AGGREGATE_VERSION_MAX = Number.MAX_SAFE_INTEGER;
export const EVENT_STABLE_TYPE_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]*$";
export const EVENT_OCCURRED_AT_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:\\d{2})$";

export const eventEnvelopeSchema = z
  .object({
    id: z.uuid(),
    customerInstanceId: z.uuid(),
    type: z
      .string()
      .min(EVENT_TYPE_MIN_LENGTH)
      .max(EVENT_TYPE_MAX_LENGTH)
      .regex(new RegExp(EVENT_STABLE_TYPE_PATTERN)),
    schemaVersion: z
      .number()
      .int()
      .min(EVENT_SCHEMA_VERSION_MIN)
      .max(EVENT_SCHEMA_VERSION_MAX),
    aggregateType: z
      .string()
      .min(EVENT_AGGREGATE_TYPE_MIN_LENGTH)
      .max(EVENT_AGGREGATE_TYPE_MAX_LENGTH)
      .regex(new RegExp(EVENT_STABLE_TYPE_PATTERN)),
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
