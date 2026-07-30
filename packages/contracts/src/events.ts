import { z } from "zod";

export const eventEnvelopeSchema = z
  .object({
    id: z.uuid(),
    customerInstanceId: z.uuid(),
    type: z.string().min(1).max(256),
    schemaVersion: z.number().int().positive(),
    aggregateType: z.string().min(1).max(256),
    aggregateId: z.uuid(),
    aggregateVersion: z.number().int().nonnegative(),
    occurredAt: z.iso.datetime({ offset: true }),
    actorId: z.uuid().optional(),
    correlationId: z.uuid(),
    causationId: z.uuid().optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
