import { z } from "zod";

import { hasUnicodeCodePointLengthWithin } from "./unicode.js";
import { blockerCodeSchema } from "./task.js";
import { activityKeySchema } from "./workflow-common.js";

export const PROBLEM_TITLE_MIN_LENGTH = 1;
export const PROBLEM_TITLE_MAX_LENGTH = 256;
export const PROBLEM_STATUS_MIN = 400;
export const PROBLEM_STATUS_MAX = 599;
export const PROBLEM_CODE_MIN_LENGTH = 1;
export const PROBLEM_CODE_MAX_LENGTH = 128;
export const PROBLEM_DETAIL_MIN_LENGTH = 0;
export const PROBLEM_DETAIL_MAX_LENGTH = 4096;

export const PLATFORM_PROBLEM_CODES = [
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
] as const;

export const WORKFLOW_ERROR_CODES = [
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
] as const;

export const platformProblemCodeSchema = z.enum(PLATFORM_PROBLEM_CODES);
export const workflowErrorCodeSchema = z.enum(WORKFLOW_ERROR_CODES);
export const problemCodeSchema = z.enum([
  ...PLATFORM_PROBLEM_CODES,
  ...WORKFLOW_ERROR_CODES,
]);

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
    code: problemCodeSchema,
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
    providerKeys: z.array(activityKeySchema).min(1).max(100),
  })
  .strict();

const statusProblemDetails = <
  const Status extends number,
  CodeSchema extends z.ZodType,
>(status: Status, code: CodeSchema) => problemDetailsSchema
  .extend({ status: z.literal(status), code })
  .strict();

export const workflowRequestProblemDetailsSchema = statusProblemDetails(
  400,
  z.literal("OCC_INVALID_REQUEST"),
);
export const workflowBadRequestProblemDetailsSchema = statusProblemDetails(
  400,
  z.enum(["OCC_INVALID_REQUEST", "OCC_INVALID_CURSOR"]),
);
export const workflowUnauthorizedProblemDetailsSchema = statusProblemDetails(
  401,
  z.literal("OCC_UNAUTHENTICATED"),
);
export const workflowForbiddenProblemDetailsSchema = statusProblemDetails(
  403,
  z.literal("OCC_FORBIDDEN"),
);
export const workflowNotFoundProblemDetailsSchema = statusProblemDetails(
  404,
  z.literal("OCC_NOT_FOUND"),
);
export const workflowInternalProblemDetailsSchema = statusProblemDetails(
  500,
  z.literal("OCC_INTERNAL_ERROR"),
);
export const workflowAuthorizationUnavailableProblemDetailsSchema = statusProblemDetails(
  503,
  z.literal("OCC_AUTHORIZATION_UNAVAILABLE"),
);
export const workflowUnavailableProblemDetailsSchema = statusProblemDetails(
  503,
  z.enum(["OCC_AUTHORIZATION_UNAVAILABLE", "OCC_WORKFLOW_UNAVAILABLE"]),
);

export const workflowCommonProblemDetailsSchema = z.discriminatedUnion("status", [
  workflowBadRequestProblemDetailsSchema,
  workflowUnauthorizedProblemDetailsSchema,
  workflowForbiddenProblemDetailsSchema,
  workflowNotFoundProblemDetailsSchema,
  workflowInternalProblemDetailsSchema,
  workflowUnavailableProblemDetailsSchema,
]);

export const cohortCreationConflictProblemDetailsSchema = statusProblemDetails(
  409,
  z.enum(["OCC_IDEMPOTENCY_CONFLICT", "OCC_DUPLICATE_COHORT_CODE"]),
);
export const versionedCommandConflictProblemDetailsSchema = statusProblemDetails(
  409,
  z.enum(["OCC_STALE_VERSION", "OCC_IDEMPOTENCY_CONFLICT", "OCC_INVALID_TRANSITION"]),
);
export const participantProcessStartConflictProblemDetailsSchema = statusProblemDetails(
  409,
  z.enum([
    "OCC_STALE_VERSION",
    "OCC_IDEMPOTENCY_CONFLICT",
    "OCC_INVALID_TRANSITION",
    "OCC_PARTICIPANT_PROCESS_EXISTS",
  ]),
);
export const processCommandConflictProblemDetailsSchema = statusProblemDetails(
  409,
  z.enum([
    "OCC_STALE_VERSION",
    "OCC_IDEMPOTENCY_CONFLICT",
    "OCC_INVALID_TRANSITION",
    "OCC_PROCESS_NOT_RUNNING",
  ]),
);
export const processTransferConflictProblemDetailsSchema = statusProblemDetails(
  409,
  z.enum([
    "OCC_STALE_VERSION",
    "OCC_IDEMPOTENCY_CONFLICT",
    "OCC_INVALID_TRANSITION",
    "OCC_PROCESS_NOT_RUNNING",
    "OCC_PARTICIPANT_PROCESS_EXISTS",
  ]),
);
export const processWaitReleaseConflictProblemDetailsSchema = statusProblemDetails(
  409,
  z.enum([
    "OCC_STALE_VERSION",
    "OCC_IDEMPOTENCY_CONFLICT",
    "OCC_PROCESS_NOT_RUNNING",
    "OCC_WAIT_NOT_ACTIVE",
  ]),
);
export const taskClaimConflictProblemDetailsSchema = statusProblemDetails(
  409,
  z.enum([
    "OCC_STALE_VERSION",
    "OCC_IDEMPOTENCY_CONFLICT",
    "OCC_INVALID_TRANSITION",
    "OCC_PROCESS_NOT_RUNNING",
    "OCC_CLAIM_CONFLICT",
  ]),
);

export const taskCompletionConflictCodeSchema = z.enum([
  "OCC_STALE_VERSION",
  "OCC_IDEMPOTENCY_CONFLICT",
  "OCC_INVALID_TRANSITION",
  "OCC_PROCESS_NOT_RUNNING",
]);

export const taskCompletionDependencyCodeSchema = z.enum([
  "OCC_AUTHORIZATION_UNAVAILABLE",
  "OCC_WORKFLOW_UNAVAILABLE",
]);

export const taskCommandConflictProblemDetailsSchema = statusProblemDetails(
  409,
  taskCompletionConflictCodeSchema,
);

export const taskCompletionGenericConflictProblemDetailsSchema = taskCommandConflictProblemDetailsSchema;
export const taskCompletionConflictProblemDetailsSchema = z.union([
  taskCompletionGenericConflictProblemDetailsSchema,
  taskBlockedProblemDetailsSchema,
]);

export const taskCompletionGenericDependencyProblemDetailsSchema = statusProblemDetails(
  503,
  taskCompletionDependencyCodeSchema,
);
export const taskCompletionDependencyProblemDetailsSchema = z.union([
  taskCompletionGenericDependencyProblemDetailsSchema,
  taskGateUnavailableProblemDetailsSchema,
]);

export const workflowListProblemDetailsSchema = z.discriminatedUnion("status", [
  workflowBadRequestProblemDetailsSchema,
  workflowUnauthorizedProblemDetailsSchema,
  workflowForbiddenProblemDetailsSchema,
  workflowAuthorizationUnavailableProblemDetailsSchema,
  workflowInternalProblemDetailsSchema,
]);
export const workflowDetailProblemDetailsSchema = z.discriminatedUnion("status", [
  workflowRequestProblemDetailsSchema,
  workflowUnauthorizedProblemDetailsSchema,
  workflowForbiddenProblemDetailsSchema,
  workflowNotFoundProblemDetailsSchema,
  workflowAuthorizationUnavailableProblemDetailsSchema,
  workflowInternalProblemDetailsSchema,
]);

const workflowCommandProblemSchemas = [
  workflowRequestProblemDetailsSchema,
  workflowUnauthorizedProblemDetailsSchema,
  workflowForbiddenProblemDetailsSchema,
  workflowNotFoundProblemDetailsSchema,
  workflowAuthorizationUnavailableProblemDetailsSchema,
  workflowInternalProblemDetailsSchema,
] as const;
const workflowEngineCommandProblemSchemas = [
  workflowRequestProblemDetailsSchema,
  workflowUnauthorizedProblemDetailsSchema,
  workflowForbiddenProblemDetailsSchema,
  workflowNotFoundProblemDetailsSchema,
  workflowUnavailableProblemDetailsSchema,
  workflowInternalProblemDetailsSchema,
] as const;

export const cohortCreationOperationProblemDetailsSchema = z.discriminatedUnion("status", [
  ...workflowCommandProblemSchemas,
  cohortCreationConflictProblemDetailsSchema,
]);
export const versionedCommandOperationProblemDetailsSchema = z.discriminatedUnion("status", [
  ...workflowCommandProblemSchemas,
  versionedCommandConflictProblemDetailsSchema,
]);
export const participantProcessStartOperationProblemDetailsSchema = z.discriminatedUnion("status", [
  ...workflowEngineCommandProblemSchemas,
  participantProcessStartConflictProblemDetailsSchema,
]);
export const processCommandOperationProblemDetailsSchema = z.discriminatedUnion("status", [
  ...workflowEngineCommandProblemSchemas,
  processCommandConflictProblemDetailsSchema,
]);
export const processTransferOperationProblemDetailsSchema = z.discriminatedUnion("status", [
  ...workflowEngineCommandProblemSchemas,
  processTransferConflictProblemDetailsSchema,
]);
export const processWaitReleaseOperationProblemDetailsSchema = z.discriminatedUnion("status", [
  ...workflowEngineCommandProblemSchemas,
  processWaitReleaseConflictProblemDetailsSchema,
]);
export const taskClaimOperationProblemDetailsSchema = z.discriminatedUnion("status", [
  ...workflowEngineCommandProblemSchemas,
  taskClaimConflictProblemDetailsSchema,
]);
export const taskCommandOperationProblemDetailsSchema = z.discriminatedUnion("status", [
  ...workflowEngineCommandProblemSchemas,
  taskCommandConflictProblemDetailsSchema,
]);
export const taskCompletionProblemDetailsSchema = z.union([
  ...workflowEngineCommandProblemSchemas,
  taskCompletionGenericConflictProblemDetailsSchema,
  taskBlockedProblemDetailsSchema,
  taskGateUnavailableProblemDetailsSchema,
]);

export type WorkflowErrorCode = z.infer<typeof workflowErrorCodeSchema>;
export type PlatformProblemCode = z.infer<typeof platformProblemCodeSchema>;
export type ProblemCode = z.infer<typeof problemCodeSchema>;
export type TaskBlockedProblemDetails = z.infer<typeof taskBlockedProblemDetailsSchema>;
export type TaskGateUnavailableProblemDetails = z.infer<typeof taskGateUnavailableProblemDetailsSchema>;
export type TaskCompletionConflictProblemDetails = z.infer<typeof taskCompletionConflictProblemDetailsSchema>;
export type TaskCompletionDependencyProblemDetails = z.infer<typeof taskCompletionDependencyProblemDetailsSchema>;
export type WorkflowCommonProblemDetails = z.infer<typeof workflowCommonProblemDetailsSchema>;
