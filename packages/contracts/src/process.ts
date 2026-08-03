import { z } from "zod";

import {
  activityKeySchema,
  cursorQuerySchema,
  cursorPageInfoSchema,
  cursorSchema,
  instantSchema,
  pageSizeSchema,
  reasonSchema,
  safeVersionSchema,
  stableCodeSchema,
  uuidSchema,
} from "./workflow-common.js";

export const processStateSchema = z.enum(["RUNNING", "SUSPENDED", "COMPLETED", "CANCELLED", "FAILED"]);
export const processTimelineTypeSchema = z.enum([
  "STARTED", "SUSPENDED", "RESUMED", "TRANSFERRED", "COMPLETED",
  "CANCELLED", "FAILED", "WAIT_RELEASED", "PROJECTION_RECONCILED",
]);
export const waitFactTypeSchema = z.enum(["PROCUREMENT_COMPLETED", "RESOURCE_READY"]);

const reasonCommand = z.object({ expectedVersion: safeVersionSchema, reason: reasonSchema }).strict();
export const suspendProcessRequestSchema = reasonCommand;
export const resumeProcessRequestSchema = reasonCommand;
export const reconcileProcessRequestSchema = reasonCommand;

export const cancelProcessRequestSchema = z
  .object({ expectedVersion: safeVersionSchema, code: stableCodeSchema, reason: reasonSchema })
  .strict();
export const failProcessRequestSchema = z
  .object({ expectedVersion: safeVersionSchema, code: stableCodeSchema, reason: reasonSchema })
  .strict();
export const transferProcessRequestSchema = z
  .object({ expectedVersion: safeVersionSchema, participantId: uuidSchema, reason: reasonSchema })
  .strict();
export const releaseProcessWaitRequestSchema = z
  .object({
    expectedVersion: safeVersionSchema,
    factType: waitFactTypeSchema,
    factId: uuidSchema,
    factVersion: safeVersionSchema,
    reason: reasonSchema,
  })
  .strict();

export const processSummarySchema = z
  .object({
    id: uuidSchema,
    cohortId: uuidSchema,
    participantId: uuidSchema,
    startedForParticipantId: uuidSchema,
    packageVersionId: uuidSchema,
    state: processStateSchema,
    version: safeVersionSchema,
    startedAt: instantSchema,
    updatedAt: instantSchema,
    endedAt: instantSchema.optional(),
  })
  .strict();
export const processDetailSchema = processSummarySchema;

export const processListQuerySchema = z
  .object({
    cohortId: uuidSchema.optional(),
    participantId: uuidSchema.optional(),
    state: processStateSchema.optional(),
    packageVersionId: uuidSchema.optional(),
    updatedBefore: instantSchema.optional(),
    cursor: cursorSchema.optional(),
    pageSize: pageSizeSchema,
  })
  .strict();
export const processPageSchema = z
  .object({ items: z.array(processSummarySchema), page: cursorPageInfoSchema })
  .strict();

export const processProgressSchema = z
  .object({
    processId: uuidSchema,
    state: processStateSchema,
    completedActivities: safeVersionSchema,
    activeActivities: z.array(activityKeySchema),
    version: safeVersionSchema,
    updatedAt: instantSchema,
  })
  .strict();
export const processParticipantSchema = z
  .object({ principalId: uuidSchema, current: z.boolean(), startedFor: z.boolean() })
  .strict();
export const processParticipantPageSchema = z
  .object({ items: z.array(processParticipantSchema), page: cursorPageInfoSchema })
  .strict();
export const processParticipantListQuerySchema = cursorQuerySchema;
export const processTaskSchema = z
  .object({ taskId: uuidSchema, activityKey: activityKeySchema, state: z.enum(["AVAILABLE", "CLAIMED", "COMPLETED", "CANCELLED", "FAILED"]), createdAt: instantSchema })
  .strict();
export const processTaskPageSchema = z
  .object({ items: z.array(processTaskSchema), page: cursorPageInfoSchema })
  .strict();
export const processTaskListQuerySchema = cursorQuerySchema;
export const processTimelineEntrySchema = z
  .object({ id: uuidSchema, type: processTimelineTypeSchema, occurredAt: instantSchema, actorId: uuidSchema.optional(), code: stableCodeSchema.optional() })
  .strict();
export const processTimelinePageSchema = z
  .object({ items: z.array(processTimelineEntrySchema), page: cursorPageInfoSchema })
  .strict();
export const processTimelineQuerySchema = cursorQuerySchema;

export type ProcessDetail = z.infer<typeof processDetailSchema>;
export type ProcessSummary = z.infer<typeof processSummarySchema>;
