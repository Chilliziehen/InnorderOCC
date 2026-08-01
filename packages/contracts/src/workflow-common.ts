import { z } from "zod";

export const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;
export const PAGE_SIZE_DEFAULT = 25;
export const PAGE_SIZE_MIN = 1;
export const PAGE_SIZE_MAX = 100;
export const CURSOR_MAX_LENGTH = 4096;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 256;
export const REASON_MAX_LENGTH = 1024;
export const CODE_MAX_LENGTH = 128;
export const DISPLAY_TEXT_MAX_LENGTH = 256;
export const ACTIVITY_KEY_MAX_LENGTH = 128;
export const ACTIVITY_KEY_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";
export const STABLE_CODE_PATTERN = "^[A-Z][A-Z0-9_]*$";

export const safeIntegerSchema = z.number().int().min(0).max(SAFE_INTEGER_MAX);
export const safeVersionSchema = safeIntegerSchema;
export const uuidSchema = z.uuid();
export const dateSchema = z.iso.date();
export const instantSchema = z.iso.datetime({ offset: true });
export const cursorSchema = z.string().min(1).max(CURSOR_MAX_LENGTH);
export const pageSizeSchema = z
  .number()
  .int()
  .min(PAGE_SIZE_MIN)
  .max(PAGE_SIZE_MAX)
  .default(PAGE_SIZE_DEFAULT);
export const idempotencyKeySchema = z.string().min(1).max(IDEMPOTENCY_KEY_MAX_LENGTH);
export const reasonSchema = z.string().min(1).max(REASON_MAX_LENGTH);
export const stableCodeSchema = z.string().min(1).max(CODE_MAX_LENGTH).regex(new RegExp(STABLE_CODE_PATTERN));
export const activityKeySchema = z.string().min(1).max(ACTIVITY_KEY_MAX_LENGTH).regex(new RegExp(ACTIVITY_KEY_PATTERN));
export const displayTextSchema = z.string().min(1).max(DISPLAY_TEXT_MAX_LENGTH);

export const cursorQuerySchema = z
  .object({
    cursor: cursorSchema.optional(),
    pageSize: pageSizeSchema,
  })
  .strict();

export const cursorPageInfoSchema = z
  .object({ nextCursor: cursorSchema.optional() })
  .strict();

export const commandHeadersSchema = z
  .object({ "Idempotency-Key": idempotencyKeySchema })
  .strict();

export const idempotentResponseHeadersSchema = z
  .object({ "X-Idempotent-Replay": z.enum(["true", "false"]) })
  .strict();

export type CursorPageInfo = z.infer<typeof cursorPageInfoSchema>;
export type CommandHeaders = z.infer<typeof commandHeadersSchema>;
export type IdempotentResponseHeaders = z.infer<typeof idempotentResponseHeadersSchema>;
