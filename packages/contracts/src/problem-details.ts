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
  })
  .strict();

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
