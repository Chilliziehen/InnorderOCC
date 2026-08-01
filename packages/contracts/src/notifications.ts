import { z } from "zod";

import { workflowEventSchema, workflowEventTypeSchema } from "./events.js";
import { unicodeBoundedStringSchema } from "./unicode.js";
import {
  cursorPageInfoSchema,
  cursorSchema,
  instantSchema,
  pageSizeSchema,
  safeIntegerSchema,
  safeVersionSchema,
  uuidSchema,
} from "./workflow-common.js";

export const NOTIFICATION_PERSISTENCE_TOKEN_MIN_LENGTH = 1;
export const NOTIFICATION_PERSISTENCE_TOKEN_MAX_LENGTH = 64;
export const NOTIFICATION_PERSISTENCE_TOKEN_PATTERN = "^[a-z0-9][a-z0-9._-]{0,63}$";
export const NOTIFICATION_SEVERITIES = ["INFO", "WARNING", "CRITICAL"] as const;

const notificationPersistenceTokenSchema = unicodeBoundedStringSchema(
  NOTIFICATION_PERSISTENCE_TOKEN_MIN_LENGTH,
  NOTIFICATION_PERSISTENCE_TOKEN_MAX_LENGTH,
)
  .regex(new RegExp(NOTIFICATION_PERSISTENCE_TOKEN_PATTERN));
export const notificationTypeSchema = notificationPersistenceTokenSchema;
export const notificationSeveritySchema = z.enum(NOTIFICATION_SEVERITIES);
export const notificationResourceTypeSchema = notificationPersistenceTokenSchema;
export const notificationSchema = z
  .object({
    id: uuidSchema,
    type: notificationTypeSchema,
    severity: notificationSeveritySchema,
    resourceType: notificationResourceTypeSchema,
    resourceId: uuidSchema,
    cursor: safeIntegerSchema,
    version: safeVersionSchema,
    createdAt: instantSchema,
    readAt: instantSchema.optional(),
  })
  .strict();
export const notificationListQuerySchema = z
  .object({
    unread: z.boolean().optional(),
    type: notificationTypeSchema.optional(),
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
    cursor: cursorSchema.optional(),
    limit: pageSizeSchema,
    filter: workflowEventTypeSchema.optional(),
  })
  .strict();
export const workflowEventPageSchema = z
  .object({ items: z.array(workflowEventSchema), page: cursorPageInfoSchema })
  .strict();

export type Notification = z.infer<typeof notificationSchema>;
