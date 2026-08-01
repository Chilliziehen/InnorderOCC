import { z } from "zod";

import {
  activityKeySchema,
  cursorPageInfoSchema,
  cursorQuerySchema,
  cursorSchema,
  displayTextSchema,
  instantSchema,
  pageSizeSchema,
  reasonSchema,
  safeVersionSchema,
  stableCodeSchema,
  uuidSchema,
} from "./workflow-common.js";

export const taskEngineStateSchema = z.enum(["AVAILABLE", "CLAIMED", "COMPLETED", "CANCELLED", "FAILED"]);
export const taskPresentationStateSchema = z.enum([
  "AVAILABLE", "CLAIMED", "BLOCKED", "PENDING_REVIEW",
  "RETURNED", "COMPLETED", "CANCELLED", "FAILED",
]);
export const blockerCodeSchema = z.enum([
  "PREREQUISITE_UNSATISFIED", "EVIDENCE_REQUIRED", "EVIDENCE_REVIEW_PENDING",
  "EVIDENCE_RETURNED", "RESOURCE_REQUIRED", "RESOURCE_CONFLICT",
  "PROCESS_SUSPENDED", "PROCESS_CANCELLED", "POLICY_DENIED",
  "GATE_PROVIDER_UNAVAILABLE",
]);
export const BLOCKER_SEVERITIES = ["SOFT", "HARD"] as const;
export const blockerSeveritySchema = z.enum(BLOCKER_SEVERITIES);
export const CONDITIONAL_RULE_VERSION_MIN_LENGTH = 1;
export const CONDITIONAL_RULE_VERSION_MAX_LENGTH = 128;
export const CONDITIONAL_RULE_VERSION_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._+-]*$";
export const PROVIDER_KEY_MIN_LENGTH = 1;
export const PROVIDER_KEY_MAX_LENGTH = 64;
export const PROVIDER_KEY_PATTERN = "^[a-z0-9][a-z0-9._-]{0,63}$";
export const conditionalRuleVersionSchema = z
  .string()
  .min(CONDITIONAL_RULE_VERSION_MIN_LENGTH)
  .max(CONDITIONAL_RULE_VERSION_MAX_LENGTH)
  .regex(new RegExp(CONDITIONAL_RULE_VERSION_PATTERN));
export const providerKeySchema = z
  .string()
  .min(PROVIDER_KEY_MIN_LENGTH)
  .max(PROVIDER_KEY_MAX_LENGTH)
  .regex(new RegExp(PROVIDER_KEY_PATTERN));
export const gateProviderStatusSchema = z.enum(["READY", "UNAVAILABLE", "STALE"]);
export const taskTimelineTypeSchema = z.enum([
  "AVAILABLE", "CLAIMED", "ASSIGNEE_CHANGED", "BLOCKED", "UNBLOCKED",
  "PENDING_REVIEW", "RETURNED", "COMPLETED", "CANCELLED", "FAILED",
  "PROJECTION_RECONCILED",
]);

export const claimTaskRequestSchema = z.object({ expectedVersion: safeVersionSchema }).strict();

export const completeTaskRequestSchema = z
  .object({ expectedVersion: safeVersionSchema })
  .strict();
export const failTaskRequestSchema = z
  .object({ expectedVersion: safeVersionSchema, code: stableCodeSchema, reason: reasonSchema })
  .strict();

export const taskBlockerSchema = z
  .object({
    id: uuidSchema,
    code: blockerCodeSchema,
    severity: blockerSeveritySchema,
    sourceType: z.enum(["TASK", "EVIDENCE", "RESOURCE", "PROCESS", "POLICY", "PROVIDER"]),
    sourceId: uuidSchema.optional(),
    providerKey: providerKeySchema.optional(),
    createdAt: instantSchema,
    resolvedAt: instantSchema.optional(),
  })
  .strict();

export const taskSummarySchema = z
  .object({
    id: uuidSchema,
    processId: uuidSchema,
    cohortId: uuidSchema,
    activityKey: activityKeySchema,
    activityName: displayTextSchema,
    state: taskEngineStateSchema,
    presentationState: taskPresentationStateSchema,
    version: safeVersionSchema,
    assigneeId: uuidSchema.optional(),
    formKey: activityKeySchema.optional(),
    dueAt: instantSchema.optional(),
    createdAt: instantSchema,
    updatedAt: instantSchema,
    completedAt: instantSchema.optional(),
    failureCode: stableCodeSchema.optional(),
    followUpDueAt: instantSchema.optional(),
    conditionalRuleVersion: conditionalRuleVersionSchema.optional(),
  })
  .strict();
export const taskDetailSchema = taskSummarySchema
  .extend({ blockers: z.array(taskBlockerSchema) })
  .strict();

export const taskMyWorkQuerySchema = z
  .object({
    presentationState: taskPresentationStateSchema.optional(),
    processId: uuidSchema.optional(),
    cohortId: uuidSchema.optional(),
    dueBefore: instantSchema.optional(),
    blockerCode: blockerCodeSchema.optional(),
    updatedBefore: instantSchema.optional(),
    cursor: cursorSchema.optional(),
    pageSize: pageSizeSchema,
  })
  .strict();
export const taskPageSchema = z
  .object({ items: z.array(taskSummarySchema), page: cursorPageInfoSchema })
  .strict();
export const taskHistoryEntrySchema = z
  .object({ id: uuidSchema, type: taskTimelineTypeSchema, occurredAt: instantSchema, actorId: uuidSchema.optional(), code: stableCodeSchema.optional() })
  .strict();
export const taskHistoryPageSchema = z
  .object({ items: z.array(taskHistoryEntrySchema), page: cursorPageInfoSchema })
  .strict();
export const taskHistoryQuerySchema = cursorQuerySchema;
export const taskBlockerPageSchema = z
  .object({ items: z.array(taskBlockerSchema), page: cursorPageInfoSchema })
  .strict();
export const taskBlockerListQuerySchema = cursorQuerySchema;

export type TaskDetail = z.infer<typeof taskDetailSchema>;
export type TaskSummary = z.infer<typeof taskSummarySchema>;
