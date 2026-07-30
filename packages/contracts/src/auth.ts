import { z } from "zod";

const usernameInputSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^(?=.*[!-~])[ -~]{1,128}$/);

const refreshTokenSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]{43}$/);

export const loginRequestSchema = z
  .object({
    username: usernameInputSchema,
    password: z.string().min(12).max(128),
  })
  .strict();

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const refreshRequestSchema = z
  .object({
    refreshToken: refreshTokenSchema,
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
    accessToken: z.string().min(1).max(8192),
    refreshToken: refreshTokenSchema,
    expiresIn: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    user: currentUserSchema,
  })
  .strict();

export type TokenResponse = z.infer<typeof tokenResponseSchema>;
