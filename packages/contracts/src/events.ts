import { z } from "zod";

import { cohortMemberRoleSchema, cohortStatusSchema } from "./cohort.js";
import { blockerCodeSchema } from "./task.js";
import {
  activityKeySchema,
  safeVersionSchema,
  stableCodeSchema,
  uuidSchema,
} from "./workflow-common.js";

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

const strictPayload = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

const typedEvent = <T extends string, A extends "COHORT" | "PROCESS" | "TASK">(
  type: T,
  aggregateType: A,
  aggregateIdKey: "cohortId" | "processId" | "taskId",
  payload: z.ZodObject<z.ZodRawShape>,
) => eventEnvelopeSchema
  .extend({
    type: z.literal(type),
    schemaVersion: z.literal(1),
    aggregateType: z.literal(aggregateType),
    payload,
  })
  .strict()
  .refine(
    (event) => event.aggregateId === event.payload[aggregateIdKey],
    { path: ["payload", aggregateIdKey], message: "payload aggregate ID must match envelope" },
  );

const cohortStatePayload = strictPayload({ cohortId: uuidSchema, status: cohortStatusSchema });

export const workflowEventSchemas = {
  "cohort.created": typedEvent("cohort.created", "COHORT", "cohortId", strictPayload({
    cohortId: uuidSchema,
    packageVersionId: uuidSchema,
    ownerPrincipalId: uuidSchema,
    status: z.literal("DRAFT"),
  })),
  "cohort.updated": typedEvent("cohort.updated", "COHORT", "cohortId", cohortStatePayload),
  "cohort.owner-transferred": typedEvent("cohort.owner-transferred", "COHORT", "cohortId", strictPayload({
    cohortId: uuidSchema,
    previousOwnerPrincipalId: uuidSchema,
    ownerPrincipalId: uuidSchema,
  })),
  "cohort.member-added": typedEvent("cohort.member-added", "COHORT", "cohortId", strictPayload({
    cohortId: uuidSchema,
    principalId: uuidSchema,
    role: cohortMemberRoleSchema,
  })),
  "cohort.member-removed": typedEvent("cohort.member-removed", "COHORT", "cohortId", strictPayload({
    cohortId: uuidSchema,
    principalId: uuidSchema,
    role: cohortMemberRoleSchema,
  })),
  "cohort.activated": typedEvent("cohort.activated", "COHORT", "cohortId", strictPayload({
    cohortId: uuidSchema,
    status: z.literal("ACTIVE"),
  })),
  "cohort.archived": typedEvent("cohort.archived", "COHORT", "cohortId", strictPayload({
    cohortId: uuidSchema,
    status: z.literal("ARCHIVED"),
  })),
  "process.started": typedEvent("process.started", "PROCESS", "processId", strictPayload({
    processId: uuidSchema,
    cohortId: uuidSchema,
    participantId: uuidSchema,
    packageVersionId: uuidSchema,
    state: z.literal("RUNNING"),
  })),
  "process.suspended": typedEvent("process.suspended", "PROCESS", "processId", strictPayload({
    processId: uuidSchema,
    state: z.literal("SUSPENDED"),
  })),
  "process.resumed": typedEvent("process.resumed", "PROCESS", "processId", strictPayload({
    processId: uuidSchema,
    state: z.literal("RUNNING"),
  })),
  "process.transferred": typedEvent("process.transferred", "PROCESS", "processId", strictPayload({
    processId: uuidSchema,
    previousParticipantId: uuidSchema,
    participantId: uuidSchema,
  })),
  "process.completed": typedEvent("process.completed", "PROCESS", "processId", strictPayload({
    processId: uuidSchema,
    state: z.literal("COMPLETED"),
  })),
  "process.cancelled": typedEvent("process.cancelled", "PROCESS", "processId", strictPayload({
    processId: uuidSchema,
    state: z.literal("CANCELLED"),
    code: stableCodeSchema,
  })),
  "process.failed": typedEvent("process.failed", "PROCESS", "processId", strictPayload({
    processId: uuidSchema,
    state: z.literal("FAILED"),
    code: stableCodeSchema,
  })),
  "process.projection-reconciled": typedEvent("process.projection-reconciled", "PROCESS", "processId", strictPayload({
    processId: uuidSchema,
    repairedTaskIds: z.array(uuidSchema).max(1000),
  })),
  "task.available": typedEvent("task.available", "TASK", "taskId", strictPayload({
    taskId: uuidSchema,
    processId: uuidSchema,
    cohortId: uuidSchema,
    activityKey: activityKeySchema,
  })),
  "task.claimed": typedEvent("task.claimed", "TASK", "taskId", strictPayload({
    taskId: uuidSchema,
    processId: uuidSchema,
    assigneeId: uuidSchema,
  })),
  "task.assignee-changed": typedEvent("task.assignee-changed", "TASK", "taskId", strictPayload({
    taskId: uuidSchema,
    processId: uuidSchema,
    previousAssigneeId: uuidSchema.optional(),
    assigneeId: uuidSchema.optional(),
  }).refine(
    (payload) => payload.previousAssigneeId !== undefined || payload.assigneeId !== undefined,
    { message: "an assignment change is required" },
  )),
  "task.blocked": typedEvent("task.blocked", "TASK", "taskId", strictPayload({
    taskId: uuidSchema,
    processId: uuidSchema,
    blockerCodes: z.array(blockerCodeSchema).min(1).max(100),
  })),
  "task.pending-review": typedEvent("task.pending-review", "TASK", "taskId", strictPayload({
    taskId: uuidSchema,
    processId: uuidSchema,
    evidenceVersionId: uuidSchema,
    reviewSequence: safeVersionSchema,
  })),
  "task.returned": typedEvent("task.returned", "TASK", "taskId", strictPayload({
    taskId: uuidSchema,
    processId: uuidSchema,
    assigneeId: uuidSchema,
    decision: z.enum(["REJECTED", "CONDITIONAL"]),
  })),
  "task.completed": typedEvent("task.completed", "TASK", "taskId", strictPayload({
    taskId: uuidSchema,
    processId: uuidSchema,
    state: z.literal("COMPLETED"),
  })),
  "task.cancelled": typedEvent("task.cancelled", "TASK", "taskId", strictPayload({
    taskId: uuidSchema,
    processId: uuidSchema,
    state: z.literal("CANCELLED"),
    code: stableCodeSchema,
  })),
  "task.failed": typedEvent("task.failed", "TASK", "taskId", strictPayload({
    taskId: uuidSchema,
    processId: uuidSchema,
    state: z.literal("FAILED"),
    code: stableCodeSchema,
  })),
  "task.projection-reconciled": typedEvent("task.projection-reconciled", "TASK", "taskId", strictPayload({
    taskId: uuidSchema,
    processId: uuidSchema,
  })),
} as const;

export type WorkflowEventType = keyof typeof workflowEventSchemas;

export const workflowEventSchema = z.unknown().transform((value, context) => {
  const type = typeof value === "object" && value !== null && "type" in value
    ? (value as { type?: unknown }).type
    : undefined;
  const schema = typeof type === "string"
    ? workflowEventSchemas[type as WorkflowEventType]
    : undefined;
  if (schema === undefined) {
    context.addIssue({ code: "custom", message: "unknown workflow event type" });
    return z.NEVER;
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    for (const issue of result.error.issues) {
      context.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
    return z.NEVER;
  }
  return result.data;
});

export type WorkflowEvent = z.infer<typeof workflowEventSchema>;
