import { z } from "zod";

const normalizedUsernameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._@-]*$/);

export const loginRequestSchema = z
  .object({
    username: normalizedUsernameSchema,
    password: z.string().min(12).max(128),
  })
  .strict();

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const refreshRequestSchema = z
  .object({
    refreshToken: z.string().min(1),
  })
  .strict();

export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const currentUserSchema = z
  .object({
    id: z.uuid(),
    username: z.string().min(1).max(128),
    displayName: z.string().min(1).max(256),
    status: z.enum(["ACTIVE", "LOCKED", "DISABLED", "ARCHIVED"]),
    capabilities: z.array(z.string().min(1).max(128)),
  })
  .strict();

export type CurrentUser = z.infer<typeof currentUserSchema>;

export const tokenResponseSchema = z
  .object({
    tokenType: z.literal("Bearer"),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    expiresIn: z.number().int().positive(),
    user: currentUserSchema,
  })
  .strict();

export type TokenResponse = z.infer<typeof tokenResponseSchema>;
