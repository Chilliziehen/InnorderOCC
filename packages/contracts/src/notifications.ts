import { z } from "zod";

import { workflowEventSchema } from "./events.js";
import {
  cursorPageInfoSchema,
  cursorSchema,
  instantSchema,
  pageSizeSchema,
  safeIntegerSchema,
  safeVersionSchema,
  uuidSchema,
} from "./workflow-common.js";

export const notificationSeveritySchema = z.enum(["INFO", "WARNING", "ERROR"]);
export const notificationResourceTypeSchema = z.enum(["COHORT", "PROCESS", "TASK"]);
export const notificationSchema = z
  .object({
    id: uuidSchema,
    type: z.string().min(1).max(128).regex(/^[A-Z][A-Z0-9_]*$/),
    severity: notificationSeveritySchema,
    resourceType: notificationResourceTypeSchema,
    resourceId: uuidSchema,
    cursor: safeIntegerSchema,
    createdAt: instantSchema,
    readAt: instantSchema.optional(),
  })
  .strict();
export const notificationListQuerySchema = z
  .object({
    unread: z.boolean().optional(),
    type: z.string().min(1).max(128).optional(),
    severity: notificationSeveritySchema.optional(),
    createdBefore: instantSchema.optional(),
    cursor: cursorSchema.optional(),
    pageSize: pageSizeSchema,
  })
  .strict();
export const notificationPageSchema = z
  .object({ items: z.array(notificationSchema), page: cursorPageInfoSchema })
  .strict();
export const markNotificationReadRequestSchema = z
  .object({ expectedVersion: safeVersionSchema })
  .strict();

export const eventCatchUpQuerySchema = z
  .object({
    afterCursor: safeIntegerSchema.optional(),
    cursor: cursorSchema.optional(),
    pageSize: pageSizeSchema,
  })
  .strict();
export const workflowEventPageSchema = z
  .object({ items: z.array(workflowEventSchema), page: cursorPageInfoSchema })
  .strict();

export type Notification = z.infer<typeof notificationSchema>;
