import { z } from "zod";

export const problemDetailsSchema = z
  .object({
    type: z.url(),
    title: z.string().min(1).max(256),
    status: z.number().int().min(400).max(599),
    code: z.string().min(1).max(128),
    correlationId: z.uuid(),
    detail: z.string().max(4096).optional(),
  })
  .strict();

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
