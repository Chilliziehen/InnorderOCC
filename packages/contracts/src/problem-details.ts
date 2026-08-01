import { z } from "zod";

import { hasUnicodeCodePointLengthWithin } from "./unicode.js";
import { blockerCodeSchema } from "./task.js";
import { activityKeySchema, safeVersionSchema, uuidSchema } from "./workflow-common.js";

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
export const baseProblemCodeSchema = problemCodeSchema.exclude([
  "OCC_STALE_VERSION",
  "OCC_PARTICIPANT_PROCESS_EXISTS",
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
    code: baseProblemCodeSchema,
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

export const staleVersionProblemDetailsSchema = problemDetailsSchema
  .extend({
    status: z.literal(409),
    code: z.literal("OCC_STALE_VERSION"),
    currentVersion: safeVersionSchema,
  })
  .strict();

export const participantProcessExistsProblemDetailsSchema = problemDetailsSchema
  .extend({
    status: z.literal(409),
    code: z.literal("OCC_PARTICIPANT_PROCESS_EXISTS"),
    existingProcessId: uuidSchema,
  })
  .strict();

export const cohortCreationConflictProblemDetailsSchema = statusProblemDetails(
  409,
  z.enum(["OCC_IDEMPOTENCY_CONFLICT", "OCC_DUPLICATE_COHORT_CODE"]),
);
export const versionedCommandGenericConflictProblemDetailsSchema = statusProblemDetails(
  409,
  z.enum(["OCC_IDEMPOTENCY_CONFLICT", "OCC_INVALID_TRANSITION"]),
);
export const versionedCommandConflictProblemDetailsSchema = z.union([
  versionedCommandGenericConflictProblemDetailsSchema,
  staleVersionProblemDetailsSchema,
]);
export const participantProcessStartGenericConflictProblemDetailsSchema = statusProblemDetails(
  409,
  z.enum([
    "OCC_IDEMPOTENCY_CONFLICT",
    "OCC_INVALID_TRANSITION",
  ]),
);
export const participantProcessStartConflictProblemDetailsSchema = z.union([
  participantProcessStartGenericConflictProblemDetailsSchema,
  staleVersionProblemDetailsSchema,
  participantProcessExistsProblemDetailsSchema,
]);
export const processCommandGenericConflictProblemDetailsSchema = statusProblemDetails(
  409,
  z.enum([
    "OCC_IDEMPOTENCY_CONFLICT",
    "OCC_INVALID_TRANSITION",
    "OCC_PROCESS_NOT_RUNNING",
  ]),
);
export const processCommandConflictProblemDetailsSchema = z.union([
  processCommandGenericConflictProblemDetailsSchema,
  staleVersionProblemDetailsSchema,
]);
export const processTransferGenericConflictProblemDetailsSchema = statusProblemDetails(
  409,
  z.enum([
    "OCC_IDEMPOTENCY_CONFLICT",
    "OCC_INVALID_TRANSITION",
    "OCC_PROCESS_NOT_RUNNING",
  ]),
);
export const processTransferConflictProblemDetailsSchema = z.union([
  processTransferGenericConflictProblemDetailsSchema,
  staleVersionProblemDetailsSchema,
  participantProcessExistsProblemDetailsSchema,
]);
export const processWaitReleaseGenericConflictProblemDetailsSchema = statusProblemDetails(
  409,
  z.enum([
    "OCC_IDEMPOTENCY_CONFLICT",
    "OCC_PROCESS_NOT_RUNNING",
    "OCC_WAIT_NOT_ACTIVE",
  ]),
);
export const processWaitReleaseConflictProblemDetailsSchema = z.union([
  processWaitReleaseGenericConflictProblemDetailsSchema,
  staleVersionProblemDetailsSchema,
]);
export const taskClaimGenericConflictProblemDetailsSchema = statusProblemDetails(
  409,
  z.enum([
    "OCC_IDEMPOTENCY_CONFLICT",
    "OCC_INVALID_TRANSITION",
    "OCC_PROCESS_NOT_RUNNING",
    "OCC_CLAIM_CONFLICT",
  ]),
);
export const taskClaimConflictProblemDetailsSchema = z.union([
  taskClaimGenericConflictProblemDetailsSchema,
  staleVersionProblemDetailsSchema,
]);

export const taskCompletionConflictCodeSchema = z.enum([
  "OCC_IDEMPOTENCY_CONFLICT",
  "OCC_INVALID_TRANSITION",
  "OCC_PROCESS_NOT_RUNNING",
]);

export const taskCompletionDependencyCodeSchema = z.enum([
  "OCC_AUTHORIZATION_UNAVAILABLE",
  "OCC_WORKFLOW_UNAVAILABLE",
]);

export const taskCompletionGenericConflictProblemDetailsSchema = statusProblemDetails(
  409,
  taskCompletionConflictCodeSchema,
);
export const taskCommandConflictProblemDetailsSchema = z.union([
  taskCompletionGenericConflictProblemDetailsSchema,
  staleVersionProblemDetailsSchema,
]);
export const taskCompletionConflictProblemDetailsSchema = z.union([
  taskCompletionGenericConflictProblemDetailsSchema,
  staleVersionProblemDetailsSchema,
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

export const workflowTopLevelListProblemDetailsSchema = z.discriminatedUnion("status", [
  workflowBadRequestProblemDetailsSchema,
  workflowUnauthorizedProblemDetailsSchema,
  workflowForbiddenProblemDetailsSchema,
  workflowAuthorizationUnavailableProblemDetailsSchema,
  workflowInternalProblemDetailsSchema,
]);
export const workflowNestedListProblemDetailsSchema = z.discriminatedUnion("status", [
  workflowBadRequestProblemDetailsSchema,
  workflowUnauthorizedProblemDetailsSchema,
  workflowForbiddenProblemDetailsSchema,
  workflowNotFoundProblemDetailsSchema,
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
export const versionedCommandOperationProblemDetailsSchema = z.union([
  ...workflowCommandProblemSchemas,
  versionedCommandGenericConflictProblemDetailsSchema,
  staleVersionProblemDetailsSchema,
]);
export const participantProcessStartOperationProblemDetailsSchema = z.union([
  ...workflowEngineCommandProblemSchemas,
  participantProcessStartGenericConflictProblemDetailsSchema,
  staleVersionProblemDetailsSchema,
  participantProcessExistsProblemDetailsSchema,
]);
export const processCommandOperationProblemDetailsSchema = z.union([
  ...workflowEngineCommandProblemSchemas,
  processCommandGenericConflictProblemDetailsSchema,
  staleVersionProblemDetailsSchema,
]);
export const processTransferOperationProblemDetailsSchema = z.union([
  ...workflowEngineCommandProblemSchemas,
  processTransferGenericConflictProblemDetailsSchema,
  staleVersionProblemDetailsSchema,
  participantProcessExistsProblemDetailsSchema,
]);
export const processWaitReleaseOperationProblemDetailsSchema = z.union([
  ...workflowEngineCommandProblemSchemas,
  processWaitReleaseGenericConflictProblemDetailsSchema,
  staleVersionProblemDetailsSchema,
]);
export const taskClaimOperationProblemDetailsSchema = z.union([
  ...workflowEngineCommandProblemSchemas,
  taskClaimGenericConflictProblemDetailsSchema,
  staleVersionProblemDetailsSchema,
]);
export const taskCommandOperationProblemDetailsSchema = z.union([
  ...workflowEngineCommandProblemSchemas,
  taskCompletionGenericConflictProblemDetailsSchema,
  staleVersionProblemDetailsSchema,
]);
export const taskCompletionProblemDetailsSchema = z.union([
  ...workflowEngineCommandProblemSchemas,
  taskCompletionGenericConflictProblemDetailsSchema,
  staleVersionProblemDetailsSchema,
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
