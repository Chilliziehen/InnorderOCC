import { z } from "zod";

import { hasUnicodeCodePointLengthWithin } from "./unicode.js";

export const PROBLEM_TITLE_MIN_LENGTH = 1;
export const PROBLEM_TITLE_MAX_LENGTH = 256;
export const PROBLEM_STATUS_MIN = 400;
export const PROBLEM_STATUS_MAX = 599;
export const PROBLEM_CODE_MIN_LENGTH = 1;
export const PROBLEM_CODE_MAX_LENGTH = 128;
export const PROBLEM_DETAIL_MIN_LENGTH = 0;
export const PROBLEM_DETAIL_MAX_LENGTH = 4096;

export const OCC_PROBLEM_CODES = [
  "OCC-API-VALIDATION",
  "OCC-API-AUTHENTICATION",
  "OCC-AUTH-INVALID-CREDENTIALS",
  "OCC-API-FORBIDDEN",
  "OCC-API-CONFLICT",
  "OCC-COMMAND-IDEMPOTENCY-KEY",
  "OCC-COMMAND-IDEMPOTENCY-CONFLICT",
  "OCC-COMMAND-METADATA",
  "OCC-COMMAND-IDEMPOTENCY-IN-PROGRESS",
  "OCC-COMMAND-IDEMPOTENCY-EXPIRED",
  "OCC-COMMAND-INTEGRITY",
  "OCC-COMMAND-OPTIMISTIC-CONFLICT",
  "OCC-AUTHZ-UNAVAILABLE",
  "OCC-API-INTERNAL",
  "OCC-API-REQUEST",
  "OCC-INVALID-REQUEST",
  "OCC-AUTHENTICATION-REQUIRED",
  "OCC-FORBIDDEN",
  "OCC-NOT-FOUND",
  "OCC-IDEMPOTENCY-CONFLICT",
  "OCC-VERSION-CONFLICT",
  "OCC-EVIDENCE-TOO-LARGE",
  "OCC-EVIDENCE-DIGEST-MISMATCH",
  "OCC-EVIDENCE-INVALID-CONTENT",
  "OCC-EVIDENCE-UPLOAD-CONFLICT",
  "OCC-EVIDENCE-REVIEW-CONFLICT",
  "OCC-RISK-INVALID-TRANSITION",
  "OCC-RESOURCE-UNAVAILABLE",
  "OCC-RESERVATION-CONFLICT",
  "OCC-INTERNAL-ERROR",
] as const;

export const occProblemCodeSchema = z.enum(OCC_PROBLEM_CODES);

export const problemDetailsSchema = z
  .object({
    type: z.url(),
    title: z
      .string()
      .refine((value) =>
        hasUnicodeCodePointLengthWithin(
          value,
          PROBLEM_TITLE_MIN_LENGTH,
          PROBLEM_TITLE_MAX_LENGTH,
        ),
      ),
    status: z.number().int().min(PROBLEM_STATUS_MIN).max(PROBLEM_STATUS_MAX),
    code: occProblemCodeSchema,
    correlationId: z.uuid(),
    detail: z
      .string()
      .refine((value) =>
        hasUnicodeCodePointLengthWithin(
          value,
          PROBLEM_DETAIL_MIN_LENGTH,
          PROBLEM_DETAIL_MAX_LENGTH,
        ),
      )
      .optional(),
    currentVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
export type OccProblemCode = z.infer<typeof occProblemCodeSchema>;
