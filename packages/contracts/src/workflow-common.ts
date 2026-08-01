import { z } from "zod";

import { unicodeBoundedStringSchema } from "./unicode.js";

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
export const REVIEW_SEQUENCE_MIN = 1;

export const safeIntegerSchema = z.number().int().min(0).max(SAFE_INTEGER_MAX);
export const safeVersionSchema = safeIntegerSchema;
export const reviewSequenceSchema = safeIntegerSchema.min(REVIEW_SEQUENCE_MIN);
export const uuidSchema = z.uuid();
export const dateSchema = z.iso.date();
export const instantSchema = z.iso.datetime({ offset: true });
export const cursorSchema = unicodeBoundedStringSchema(1, CURSOR_MAX_LENGTH);
export const pageSizeSchema = z
  .number()
  .int()
  .min(PAGE_SIZE_MIN)
  .max(PAGE_SIZE_MAX)
  .default(PAGE_SIZE_DEFAULT);
export const idempotencyKeySchema = unicodeBoundedStringSchema(1, IDEMPOTENCY_KEY_MAX_LENGTH);
export const reasonSchema = unicodeBoundedStringSchema(1, REASON_MAX_LENGTH);
export const stableCodeSchema = unicodeBoundedStringSchema(1, CODE_MAX_LENGTH).regex(new RegExp(STABLE_CODE_PATTERN));
export const activityKeySchema = unicodeBoundedStringSchema(1, ACTIVITY_KEY_MAX_LENGTH).regex(new RegExp(ACTIVITY_KEY_PATTERN));
export const displayTextSchema = unicodeBoundedStringSchema(1, DISPLAY_TEXT_MAX_LENGTH);

const normalizePlainObjectHeaderNames = (input: unknown): unknown => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return input;

  const normalized = Object.create(null) as Record<string, unknown>;
  for (const [name, value] of Object.entries(input)) {
    const canonicalName = name.toLowerCase();
    if (Object.hasOwn(normalized, canonicalName)) return null;
    normalized[canonicalName] = value;
  }
  return normalized;
};

export const cursorQuerySchema = z
  .object({
    cursor: cursorSchema.optional(),
    pageSize: pageSizeSchema,
  })
  .strict();

export const cursorPageInfoSchema = z
  .object({ nextCursor: cursorSchema.optional() })
  .strict();

export const commandHeadersSchema = z.preprocess(
  normalizePlainObjectHeaderNames,
  z.object({ "idempotency-key": idempotencyKeySchema }).strict(),
);

export const idempotentResponseHeadersSchema = z.preprocess(
  normalizePlainObjectHeaderNames,
  z.object({ "x-idempotent-replay": z.enum(["true", "false"]) }).strict(),
);

export type CursorPageInfo = z.infer<typeof cursorPageInfoSchema>;
export type CommandHeaders = z.infer<typeof commandHeadersSchema>;
export type IdempotentResponseHeaders = z.infer<typeof idempotentResponseHeadersSchema>;
