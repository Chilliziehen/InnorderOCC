import { z } from "zod";

const LogLevelSchema = z.enum([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
]);

const ConfigSchema = z
  .object({
    environment: z
      .enum(["development", "test", "production"])
      .default("development"),
    host: z.string().trim().min(1).default("127.0.0.1"),
    logLevel: LogLevelSchema.default("info"),
    port: z.coerce.number().int().min(1).max(65_535).default(3100),
    version: z.string().trim().min(1).default("dev"),
  })
  .strict();

export type ServiceConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(
  environment: Record<string, string | undefined> = process.env,
): ServiceConfig {
  return ConfigSchema.parse({
    environment: environment.NODE_ENV,
    host: environment.HOST,
    logLevel: environment.LOG_LEVEL,
    port: environment.PORT,
    version: environment.npm_package_version,
  });
}
