import { z } from "zod";

import { hasUnicodeCodePointLengthWithin } from "./unicode.js";
import { blockerCodeSchema } from "./task.js";

export const PROBLEM_TITLE_MIN_LENGTH = 1;
export const PROBLEM_TITLE_MAX_LENGTH = 256;
export const PROBLEM_STATUS_MIN = 400;
export const PROBLEM_STATUS_MAX = 599;
export const PROBLEM_CODE_MIN_LENGTH = 1;
export const PROBLEM_CODE_MAX_LENGTH = 128;
export const PROBLEM_DETAIL_MIN_LENGTH = 0;
export const PROBLEM_DETAIL_MAX_LENGTH = 4096;

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
    code: z
      .string()
      .min(PROBLEM_CODE_MIN_LENGTH)
      .max(PROBLEM_CODE_MAX_LENGTH),
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

export const workflowErrorCodeSchema = z.enum([
  "OCC_INVALID_REQUEST",
  "OCC_INVALID_CURSOR",
  "OCC_UNAUTHENTICATED",
  "OCC_FORBIDDEN",
  "OCC_NOT_FOUND",
  "OCC_IDEMPOTENCY_CONFLICT",
  "OCC_DUPLICATE_COHORT_CODE",
  "OCC_STALE_VERSION",
  "OCC_CLAIM_CONFLICT",
  "OCC_PARTICIPANT_PROCESS_EXISTS",
  "OCC_INVALID_TRANSITION",
  "OCC_PROCESS_NOT_RUNNING",
  "OCC_TASK_BLOCKED",
  "OCC_WAIT_NOT_ACTIVE",
  "OCC_TASK_GATE_UNAVAILABLE",
  "OCC_AUTHORIZATION_UNAVAILABLE",
  "OCC_WORKFLOW_UNAVAILABLE",
  "OCC_INTERNAL_ERROR",
]);

export const taskBlockedProblemDetailsSchema = problemDetailsSchema
  .extend({
    status: z.literal(409),
    code: z.literal("OCC_TASK_BLOCKED"),
    blockerCodes: z.array(blockerCodeSchema).min(1).max(100),
  })
  .strict();

export const taskGateUnavailableProblemDetailsSchema = problemDetailsSchema
  .extend({
    status: z.literal(503),
    code: z.literal("OCC_TASK_GATE_UNAVAILABLE"),
    providerKeys: z.array(z.string().min(1).max(128)).min(1).max(100),
  })
  .strict();

export type WorkflowErrorCode = z.infer<typeof workflowErrorCodeSchema>;
export type TaskBlockedProblemDetails = z.infer<typeof taskBlockedProblemDetailsSchema>;
export type TaskGateUnavailableProblemDetails = z.infer<typeof taskGateUnavailableProblemDetailsSchema>;
