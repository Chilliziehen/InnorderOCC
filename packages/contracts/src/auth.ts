import { z } from "zod";

export const LOGIN_USERNAME_MIN_LENGTH = 1;
export const LOGIN_USERNAME_MAX_LENGTH = 128;
export const LOGIN_USERNAME_PATTERN = `^(?=.*[!-~])[ -~]{${LOGIN_USERNAME_MIN_LENGTH},${LOGIN_USERNAME_MAX_LENGTH}}$`;
export const LOGIN_PASSWORD_MIN_CODE_POINTS = 12;
export const LOGIN_PASSWORD_MAX_CODE_POINTS = 128;
export const REFRESH_TOKEN_LENGTH = 43;
export const REFRESH_TOKEN_PATTERN = `^[A-Za-z0-9_-]{${REFRESH_TOKEN_LENGTH}}$`;
export const CURRENT_USER_USERNAME_MIN_LENGTH = 1;
export const CURRENT_USER_USERNAME_MAX_LENGTH = 128;
export const CURRENT_USER_DISPLAY_NAME_MIN_LENGTH = 1;
export const CURRENT_USER_DISPLAY_NAME_MAX_LENGTH = 256;
export const CAPABILITY_MIN_LENGTH = 1;
export const CAPABILITY_MAX_LENGTH = 128;
export const ACCESS_TOKEN_MIN_LENGTH = 1;
export const ACCESS_TOKEN_MAX_LENGTH = 8192;
export const EXPIRES_IN_MIN_SECONDS = 1;
export const EXPIRES_IN_MAX_SECONDS = Number.MAX_SAFE_INTEGER;

const usernameInputSchema = z
  .string()
  .min(LOGIN_USERNAME_MIN_LENGTH)
  .max(LOGIN_USERNAME_MAX_LENGTH)
  .regex(new RegExp(LOGIN_USERNAME_PATTERN));

const refreshTokenSchema = z
  .string()
  .length(REFRESH_TOKEN_LENGTH)
  .regex(new RegExp(REFRESH_TOKEN_PATTERN));

const passwordInputSchema = z.string().refine(
  (value) => {
    const codePointLength = [...value].length;
    return (
      codePointLength >= LOGIN_PASSWORD_MIN_CODE_POINTS &&
      codePointLength <= LOGIN_PASSWORD_MAX_CODE_POINTS
    );
  },
  `Password must contain ${LOGIN_PASSWORD_MIN_CODE_POINTS}-${LOGIN_PASSWORD_MAX_CODE_POINTS} Unicode code points`,
);

export const loginRequestSchema = z
  .object({
    username: usernameInputSchema,
    password: passwordInputSchema,
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
    username: z
      .string()
      .min(CURRENT_USER_USERNAME_MIN_LENGTH)
      .max(CURRENT_USER_USERNAME_MAX_LENGTH),
    displayName: z
      .string()
      .min(CURRENT_USER_DISPLAY_NAME_MIN_LENGTH)
      .max(CURRENT_USER_DISPLAY_NAME_MAX_LENGTH),
    status: z.enum(["ACTIVE", "LOCKED", "DISABLED", "ARCHIVED"]),
    capabilities: z.array(
      z.string().min(CAPABILITY_MIN_LENGTH).max(CAPABILITY_MAX_LENGTH),
    ),
  })
  .strict();

export type CurrentUser = z.infer<typeof currentUserSchema>;

export const tokenResponseSchema = z
  .object({
    tokenType: z.literal("Bearer"),
    accessToken: z
      .string()
      .min(ACCESS_TOKEN_MIN_LENGTH)
      .max(ACCESS_TOKEN_MAX_LENGTH),
    refreshToken: refreshTokenSchema,
    expiresIn: z
      .number()
      .int()
      .min(EXPIRES_IN_MIN_SECONDS)
      .max(EXPIRES_IN_MAX_SECONDS),
    user: currentUserSchema,
  })
  .strict();

export type TokenResponse = z.infer<typeof tokenResponseSchema>;
