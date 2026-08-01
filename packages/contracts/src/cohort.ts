import { z } from "zod";

import { unicodeBoundedStringSchema } from "./unicode.js";

import {
  cursorPageInfoSchema,
  cursorSchema,
  dateSchema,
  displayTextSchema,
  instantSchema,
  pageSizeSchema,
  reasonSchema,
  safeVersionSchema,
  uuidSchema,
} from "./workflow-common.js";

export const COHORT_DATE_ORDER_CONSTRAINT = "endDate-gte-startDate";
export const COHORT_CODE_MAX_LENGTH = 64;
export const COHORT_CODE_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";

const cohortCodeSchema = unicodeBoundedStringSchema(1, COHORT_CODE_MAX_LENGTH);

const hasValidDateOrder = (value: {
  startDate?: string | undefined;
  endDate?: string | null | undefined;
}): boolean =>
  value.startDate === undefined || value.endDate === undefined || value.endDate === null || value.endDate >= value.startDate;

export const cohortStatusSchema = z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]);
export const cohortMemberRoleSchema = z.enum(["OWNER", "TEACHER", "PARTICIPANT"]);
export const cohortManageableMemberRoleSchema = z.enum(["TEACHER", "PARTICIPANT"]);

export const createCohortRequestSchema = z
  .object({
    code: cohortCodeSchema.regex(new RegExp(COHORT_CODE_PATTERN)),
    name: displayTextSchema,
    packageVersionId: uuidSchema,
    ownerPrincipalId: uuidSchema,
    startDate: dateSchema,
    endDate: dateSchema.optional(),
  })
  .strict()
  .refine(hasValidDateOrder, {
    path: ["endDate"],
    message: COHORT_DATE_ORDER_CONSTRAINT,
  });

export const updateCohortRequestSchema = z
  .object({
    expectedVersion: safeVersionSchema,
    name: displayTextSchema.optional(),
    startDate: dateSchema.optional(),
    endDate: dateSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.startDate !== undefined || value.endDate !== undefined, {
    message: "at least one update is required",
  })
  .refine(hasValidDateOrder, {
    path: ["endDate"],
    message: COHORT_DATE_ORDER_CONSTRAINT,
  });

export const addCohortMemberRequestSchema = z
  .object({
    expectedVersion: safeVersionSchema,
    principalId: uuidSchema,
    role: cohortManageableMemberRoleSchema,
    validUntil: instantSchema.optional(),
  })
  .strict();

export const removeCohortMemberRequestSchema = z
  .object({
    expectedVersion: safeVersionSchema,
    principalId: uuidSchema,
    role: cohortManageableMemberRoleSchema,
  })
  .strict();

export const archiveCohortRequestSchema = z
  .object({ expectedVersion: safeVersionSchema, reason: reasonSchema })
  .strict();

export const transferCohortOwnerRequestSchema = z
  .object({
    expectedVersion: safeVersionSchema,
    ownerPrincipalId: uuidSchema,
    reason: reasonSchema,
  })
  .strict();

export const startParticipantProcessRequestSchema = z
  .object({ expectedVersion: safeVersionSchema })
  .strict();

export const cohortMemberSchema = z
  .object({
    principalId: uuidSchema,
    role: cohortMemberRoleSchema,
    validFrom: instantSchema,
    validUntil: instantSchema.optional(),
  })
  .strict();

export const cohortSummarySchema = z
  .object({
    id: uuidSchema,
    code: cohortCodeSchema,
    name: displayTextSchema,
    packageVersionId: uuidSchema,
    ownerPrincipalId: uuidSchema,
    startDate: dateSchema,
    endDate: dateSchema.nullable(),
    status: cohortStatusSchema,
    version: safeVersionSchema,
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .strict();

export const cohortDetailSchema = cohortSummarySchema
  .extend({ members: z.array(cohortMemberSchema).max(10000) })
  .strict();

export const cohortListQuerySchema = z
  .object({
    status: cohortStatusSchema.optional(),
    packageVersionId: uuidSchema.optional(),
    updatedBefore: instantSchema.optional(),
    cursor: cursorSchema.optional(),
    pageSize: pageSizeSchema,
  })
  .strict();

export const cohortPageSchema = z
  .object({ items: z.array(cohortSummarySchema), page: cursorPageInfoSchema })
  .strict();

export const startParticipantProcessResponseSchema = z
  .object({ processId: uuidSchema, cohortId: uuidSchema, participantId: uuidSchema, version: safeVersionSchema })
  .strict();

export type CohortDetail = z.infer<typeof cohortDetailSchema>;
export type CohortSummary = z.infer<typeof cohortSummarySchema>;
