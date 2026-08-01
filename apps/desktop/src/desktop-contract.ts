import {
  currentUserSchema,
  loginRequestSchema,
  SystemStatusSchema,
  type SystemStatus,
} from "@innorder/contracts";
import { z } from "zod";

const environmentSchema = z.enum(["production", "pilot", "development"]);
const caFingerprintSchema = z
  .string()
  .regex(
    /^(?:[0-9A-Fa-f]{64}|(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2})$/,
    "Invalid SHA-256 CA fingerprint",
  )
  .transform((value) => value.replaceAll(":", "").toUpperCase())
  .pipe(z.string().regex(/^[0-9A-F]{64}$/));

const ROOT_ORIGIN_INPUT_PATTERN =
  /^[A-Za-z][A-Za-z\d+.-]*:\/\/[^\s/?#\\@]+\/?$/;

function isExactRootOrigin(value: string, requireCanonical: boolean): boolean {
  if (!ROOT_ORIGIN_INPUT_PATTERN.test(value)) {
    return false;
  }

  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password
    ) {
      return false;
    }
    return !requireCanonical || value === url.origin;
  } catch {
    return false;
  }
}

const profileOriginInputSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => isExactRootOrigin(value, false), {
    message: "Server origin must be an exact root origin",
  });

const persistedProfileOriginSchema = z
  .string()
  .refine((value) => isExactRootOrigin(value, true), {
    message: "Server origin must be a canonical root origin",
  });

export const profileInputSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1).max(128),
  origin: profileOriginInputSchema,
  environment: environmentSchema.optional(),
  caFingerprint: caFingerprintSchema.optional(),
});

export type ProfileInput = z.input<typeof profileInputSchema>;

export const serverProfileSchema = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1).max(128),
    origin: persistedProfileOriginSchema,
    environment: environmentSchema,
    caFingerprint: z.string().regex(/^[0-9A-F]{64}$/).optional(),
  })
  .strict();

export type ServerProfile = z.infer<typeof serverProfileSchema>;

export function parseServerProfile(
  input: ProfileInput,
  packaged: boolean,
  allowDevelopmentHttp = false,
): ServerProfile {
  const parsed = profileInputSchema.parse(input);
  const url = new URL(parsed.origin);

  if (url.username || url.password) {
    throw new Error("URL credentials are not allowed");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Server origin must be an exact root origin");
  }

  const isLoopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    url.hostname.toLowerCase(),
  );
  const developmentHttpAllowed =
    url.protocol === "http:" &&
    !packaged &&
    allowDevelopmentHttp &&
    isLoopback;

  if (url.protocol !== "https:" && !developmentHttpAllowed) {
    throw new Error("HTTPS is required");
  }

  return serverProfileSchema.parse({
    id: parsed.id ?? crypto.randomUUID(),
    name: parsed.name,
    origin: url.origin,
    environment: developmentHttpAllowed
      ? "development"
      : (parsed.environment ?? "pilot"),
    caFingerprint: parsed.caFingerprint,
  });
}

export const loginInputSchema = loginRequestSchema;
export type LoginInput = z.infer<typeof loginInputSchema>;

export const sessionSnapshotSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("anonymous") }).strict(),
  z
    .object({
      state: z.literal("authenticated"),
      user: currentUserSchema,
      expiresAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
]);
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;

export const connectivitySchema = z.enum(["checking", "online", "offline"]);
export type Connectivity = z.infer<typeof connectivitySchema>;

export const workspaceQuerySchema = z
  .object({
    workspace: z.string().trim().min(1).max(128),
    operation: z.string().trim().min(1).max(128),
    filters: z.record(z.string(), z.unknown()).optional(),
    sort: z
      .object({ field: z.string().min(1), direction: z.enum(["asc", "desc"]) })
      .strict()
      .optional(),
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();
export type WorkspaceQuery = z.infer<typeof workspaceQuerySchema>;

export const problemReceiptSchema = z
  .object({
    title: z.string().min(1),
    detail: z.string().optional(),
    status: z.number().int().min(400).max(599),
    correlationId: z.uuid().optional(),
  })
  .strict();
export type ProblemReceipt = z.infer<typeof problemReceiptSchema>;

const workspaceItemSchema = z.record(z.string(), z.unknown());
export const workspaceResultSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("ready"),
      items: z.array(workspaceItemSchema).min(1),
      nextCursor: z.string().optional(),
      fetchedAt: z.iso.datetime({ offset: true }),
      stale: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      state: z.literal("empty"),
      fetchedAt: z.iso.datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      state: z.literal("unavailable"),
      reason: z.literal("UNAVAILABLE_CONTRACT"),
      resourceGroups: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z.object({ state: z.literal("problem"), problem: problemReceiptSchema }).strict(),
]);
export type WorkspaceResult = z.infer<typeof workspaceResultSchema>;

export const workspaceCommandSchema = z
  .object({
    workspace: z.string().trim().min(1).max(128),
    operation: z.string().trim().min(1).max(128),
    targetId: z.string().min(1).max(256).optional(),
    payload: z.record(z.string(), z.unknown()).default({}),
    idempotencyKey: z.uuid(),
  })
  .strict();
export type WorkspaceCommand = z.input<typeof workspaceCommandSchema>;

export const commandReceiptSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("accepted"),
      commandId: z.uuid(),
      correlationId: z.uuid(),
    })
    .strict(),
  z
    .object({
      state: z.literal("completed"),
      commandId: z.uuid(),
      correlationId: z.uuid(),
      result: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      state: z.literal("conflict"),
      correlationId: z.uuid(),
      detail: z.string().optional(),
    })
    .strict(),
  z
    .object({
      state: z.literal("unavailable"),
      reason: z.literal("UNAVAILABLE_CONTRACT"),
      resourceGroups: z.array(z.string().min(1)).min(1),
    })
    .strict(),
  z.object({ state: z.literal("problem"), problem: problemReceiptSchema }).strict(),
]);
export type CommandReceipt = z.infer<typeof commandReceiptSchema>;

export const evidenceUploadInputSchema = z
  .object({
    workspace: z.string().trim().min(1).max(128),
    targetId: z.string().min(1).max(256),
    fileName: z.string().trim().min(1).max(255),
    contentType: z.string().trim().min(1).max(255),
    size: z.number().int().min(1).max(100 * 1024 * 1024),
    data: z.instanceof(Uint8Array),
  })
  .strict()
  .refine(({ data, size }) => data.byteLength === size, {
    message: "Upload size does not match data length",
  });
export type EvidenceUploadInput = z.infer<typeof evidenceUploadInputSchema>;

export const uploadReceiptSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("started"), uploadId: z.uuid() }).strict(),
  z
    .object({
      state: z.literal("completed"),
      uploadId: z.uuid(),
      evidenceId: z.string().min(1),
    })
    .strict(),
  z.object({ state: z.literal("problem"), problem: problemReceiptSchema }).strict(),
]);
export type UploadReceipt = z.infer<typeof uploadReceiptSchema>;

export const notificationEventSchema = z
  .object({
    id: z.uuid(),
    type: z.string().min(1).max(256),
    occurredAt: z.iso.datetime({ offset: true }),
    title: z.string().min(1).max(256),
    body: z.string().max(4096).optional(),
    read: z.boolean(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type NotificationEvent = z.infer<typeof notificationEventSchema>;

export const notificationPageSchema = z
  .object({
    items: z.array(notificationEventSchema),
    nextCursor: z.string().optional(),
  })
  .strict();
export type NotificationPage = z.infer<typeof notificationPageSchema>;

export interface OccApi {
  profiles: {
    list(): Promise<ServerProfile[]>;
    save(input: ProfileInput): Promise<ServerProfile>;
    select(id: string): Promise<void>;
    remove(id: string): Promise<void>;
  };
  session: {
    restore(): Promise<SessionSnapshot>;
    login(input: LoginInput): Promise<SessionSnapshot>;
    logout(): Promise<void>;
  };
  runtime: { statuses(): Promise<SystemStatus[]> };
  workspaces: { query(input: WorkspaceQuery): Promise<WorkspaceResult> };
  commands: { execute(input: WorkspaceCommand): Promise<CommandReceipt> };
  uploads: {
    start(input: EvidenceUploadInput): Promise<UploadReceipt>;
    cancel(uploadId: string): Promise<void>;
  };
  notifications: {
    list(cursor?: string): Promise<NotificationPage>;
    subscribe(listener: (event: NotificationEvent) => void): () => void;
  };
}

export const systemStatusesSchema = z.array(SystemStatusSchema);
