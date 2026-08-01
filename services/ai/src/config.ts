import { z } from "zod";

const LogLevelSchema = z.enum([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
]);
const BooleanSchema = z.preprocess((value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

const ConfigSchema = z
  .object({
    environment: z
      .enum(["development", "test", "production"])
      .default("development"),
    host: z.string().trim().min(1).default("127.0.0.1"),
    logLevel: LogLevelSchema.default("info"),
    port: z.coerce.number().int().min(1).max(65_535).default(3100),
    version: z.string().trim().min(1).default("dev"),
    businessEnabled: BooleanSchema.default(false),
    databaseUrl: z.string().url().startsWith("postgresql://").optional(),
    databasePasswordFile: z.string().min(1).max(1024).optional(),
    tlsKeyFile: z.string().min(1).max(1024).optional(),
    tlsCertificateFiles: z.array(z.string().min(1).max(1024)).min(1).max(2).optional(),
    tlsCaFiles: z.array(z.string().min(1).max(1024)).min(1).max(2).optional(),
    revokedSerialsFile: z.string().min(1).max(1024).optional(),
    grantKeys: z.array(z.object({ kid: z.string().min(1).max(128), file: z.string().min(1).max(1024) }).strict()).min(1).max(2).optional(),
    coreOrigin: z.string().url().startsWith("https://").optional(),
    databasePoolSize: z.coerce.number().int().min(1).max(32).default(10),
  })
  .strict()
  .superRefine((config, context) => {
    if (!config.businessEnabled) return;
    for (const key of ["databaseUrl", "databasePasswordFile", "tlsKeyFile", "tlsCertificateFiles", "tlsCaFiles", "revokedSerialsFile", "grantKeys", "coreOrigin"] as const) {
      if (config[key] === undefined) context.addIssue({ code: "custom", path: [key], message: "Required when AI business routes are enabled" });
    }
    if (config.databaseUrl !== undefined) {
      const database = new URL(config.databaseUrl);
      if (database.protocol !== "postgresql:" || database.username !== "innorder_ai_runtime" || database.password || database.search || database.hash) {
        context.addIssue({ code: "custom", path: ["databaseUrl"], message: "AI database URL must use the dedicated runtime identity" });
      }
    }
    if (config.coreOrigin !== undefined) {
      const core = new URL(config.coreOrigin);
      if (core.username || core.password || core.pathname !== "/" || core.search || core.hash || core.origin !== config.coreOrigin) {
        context.addIssue({ code: "custom", path: ["coreOrigin"], message: "Core origin must be exact" });
      }
    }
  });

export type ServiceConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(
  environment: Record<string, string | undefined> = process.env,
): ServiceConfig {
  const raw = {
    environment: environment.NODE_ENV,
    host: environment.HOST,
    logLevel: environment.LOG_LEVEL,
    port: environment.PORT,
    version: environment.npm_package_version,
    businessEnabled: environment.AI_BUSINESS_ENABLED,
    databaseUrl: environment.AI_DATABASE_URL,
    databasePasswordFile: environment.AI_DATABASE_PASSWORD_FILE,
    tlsKeyFile: environment.AI_TLS_KEY_FILE,
    tlsCertificateFiles: environment.AI_TLS_CERT_FILES?.split(","),
    tlsCaFiles: environment.AI_TLS_CA_FILES?.split(","),
    revokedSerialsFile: environment.AI_REVOKED_SERIALS_FILE,
    grantKeys: environment.AI_GRANT_PUBLIC_KEYS?.split(",").map((entry) => {
      const separator = entry.indexOf(":");
      return { kid: entry.slice(0, separator), file: entry.slice(separator + 1) };
    }),
    coreOrigin: environment.CORE_INTERNAL_ORIGIN,
  };
  return ConfigSchema.parse(Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined)));
}
