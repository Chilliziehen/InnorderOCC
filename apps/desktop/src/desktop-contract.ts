import {
  currentUserSchema,
  loginRequestSchema,
  SystemStatusSchema,
  type SystemStatus,
} from "@innorder/contracts";
import { z } from "zod";

import { commandPayloadSchema } from "./command-payload";

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

export const selectedServerProfileSchema = serverProfileSchema.nullable();

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
    code: z.string().trim().min(1).max(128).optional(),
    retryable: z.boolean().optional(),
    status: z.number().int().min(400).max(599),
    correlationId: z.uuid().optional(),
    currentVersion: z.number().int().min(0).optional(),
  })
  .strict();
export type ProblemReceipt = z.infer<typeof problemReceiptSchema>;

const workspaceItemSchema = z.record(z.string(), z.unknown());
const workspaceDataSchema = {
  items: z.array(workspaceItemSchema).min(1),
  count: z.number().int().min(1),
  nextCursor: z.string().min(1).max(2048).optional(),
  fetchedAt: z.iso.datetime({ offset: true }),
} as const;
const staleWorkspaceDataSchema = {
  items: z.array(workspaceItemSchema),
  count: z.number().int().min(0),
  nextCursor: z.string().min(1).max(2048).optional(),
  fetchedAt: z.iso.datetime({ offset: true }),
} as const;
export const workspaceResultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("loading"), label: z.string().trim().min(1).max(256) }).strict(),
  z
    .object({
      state: z.literal("ready"),
      ...workspaceDataSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("empty"),
      fetchedAt: z.iso.datetime({ offset: true }),
      nextCommand: z.object({
        label: z.string().trim().min(1).max(256),
        permitted: z.boolean(),
      }).strict().optional(),
    })
    .strict(),
  z.object({
    state: z.literal("error"),
    problem: problemReceiptSchema.extend({ code: z.string().trim().min(1).max(128) }).strict(),
  }).strict(),
  z.object({ state: z.literal("stale"), ...staleWorkspaceDataSchema }).strict(),
  z.object({ state: z.literal("offline"), ...workspaceDataSchema }).strict(),
  z.object({
    state: z.literal("conflict"),
    currentVersion: z.number().int().min(0),
    correlationId: z.uuid().optional(),
  }).strict(),
  z
    .object({
      state: z.literal("unavailable"),
      reason: z.literal("UNAVAILABLE_CONTRACT"),
      resourceGroups: z.array(z.string().min(1)).min(1),
      message: z.string().trim().min(1).max(1024),
    })
    .strict(),
]);
export type WorkspaceResult = z.infer<typeof workspaceResultSchema>;

export const workspaceCommandSchema = z
  .object({
    workspace: z.string().trim().min(1).max(128),
    operation: z.string().trim().min(1).max(128),
    targetId: z.string().min(1).max(256).optional(),
    payload: commandPayloadSchema.default({}),
    intentHandle: z.uuid(),
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
      currentVersion: z.number().int().min(0),
      detail: z.string().optional(),
    })
    .strict(),
  z
    .object({
      state: z.literal("unavailable"),
      reason: z.literal("UNAVAILABLE_CONTRACT"),
      resourceGroups: z.array(z.string().min(1)).min(1),
      message: z.string().trim().min(1).max(1024),
    })
    .strict(),
  z.object({ state: z.literal("problem"), problem: problemReceiptSchema }).strict(),
]);
export type CommandReceipt = z.infer<typeof commandReceiptSchema>;

export const commandSettlementSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("completed"), correlationId: z.uuid() }).strict(),
  z.object({
    state: z.literal("problem"),
    correlationId: z.uuid(),
    problem: problemReceiptSchema.extend({ correlationId: z.uuid() }).strict(),
  }).strict(),
]).superRefine((settlement, context) => {
  if (settlement.state === "problem" && settlement.problem.correlationId !== settlement.correlationId) {
    context.addIssue({ code: "custom", message: "Command settlement correlation mismatch" });
  }
});
export type CommandSettlement = z.infer<typeof commandSettlementSchema>;

export const evidenceUploadMetadataSchema = z
  .object({
    workspace: z.string().trim().min(1).max(128),
    taskId: z.string().trim().min(1).max(256),
    fileName: z.string().trim().min(1).max(255),
    mediaType: z.string().trim().min(1).max(255),
    size: z.number().int().min(1).max(100 * 1024 * 1024),
    intentHandle: z.uuid(),
  })
  .strict();
export type EvidenceUploadMetadata = z.infer<typeof evidenceUploadMetadataSchema>;

export const uploadAppendInputSchema = z.object({
  uploadId: z.uuid(),
  sequence: z.number().int().nonnegative(),
  data: z.union([z.instanceof(Uint8Array), z.instanceof(ArrayBuffer)]).transform((value) =>
    value instanceof Uint8Array ? value : new Uint8Array(value),
  ).refine((value) => value.byteLength > 0 && value.byteLength <= 1024 * 1024, "Upload chunk exceeds byte limit"),
}).strict();
export type UploadAppendInput = z.infer<typeof uploadAppendInputSchema>;

export const uploadAppendReceiptSchema = z.object({
  acceptedBytes: z.number().int().positive().max(1024 * 1024),
  receivedBytes: z.number().int().positive().max(100 * 1024 * 1024),
}).strict();
export type UploadAppendReceipt = z.infer<typeof uploadAppendReceiptSchema>;

export const uploadProgressSchema = z.object({
  uploadId: z.uuid(),
  intentHandle: z.uuid(),
  percent: z.number().int().min(0).max(100),
}).strict();
export type UploadProgress = z.infer<typeof uploadProgressSchema>;

const uploadReferenceSchema = z.string().trim().min(1).max(512);
export const uploadTransportResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("evidence"), evidenceId: z.string().trim().min(1).max(256),
    uploadReference: uploadReferenceSchema,
    quarantineStatus: z.enum(["quarantined", "released", "rejected"]),
    processingStatus: z.enum(["scanning", "ready", "failed"]),
    reviewStatus: z.enum(["pending", "accepted", "returned", "rejected"]),
  }).strict(),
  z.object({
    kind: z.literal("archive"), uploadReference: uploadReferenceSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
]);
export type UploadTransportResponse = z.infer<typeof uploadTransportResponseSchema>;

export const uploadAvailabilitySchema = z.union([
  z.object({ state: z.literal("available"), maxBytes: z.literal(100 * 1024 * 1024) }).strict(),
  z.object({ state: z.literal("unavailable"), reason: z.literal("UNAVAILABLE_CONTRACT"), resourceGroups: z.array(z.string().min(1)).min(1), message: z.string().trim().min(1).max(1024) }).strict(),
]);
export type UploadAvailability = z.infer<typeof uploadAvailabilitySchema>;

export const uploadReceiptSchema = z.union([
  z.object({ state: z.literal("started"), uploadId: z.uuid() }).strict(),
  z.object({ state: z.literal("completed"), uploadId: z.uuid(), kind: z.literal("evidence"), evidenceId: z.string().trim().min(1).max(256), uploadReference: uploadReferenceSchema, quarantineStatus: z.enum(["quarantined", "released", "rejected"]), processingStatus: z.enum(["scanning", "ready", "failed"]), reviewStatus: z.enum(["pending", "accepted", "returned", "rejected"]) }).strict(),
  z.object({ state: z.literal("completed"), uploadId: z.uuid(), kind: z.literal("archive"), uploadReference: uploadReferenceSchema, sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  z.object({
    state: z.literal("unavailable"),
    reason: z.literal("UNAVAILABLE_CONTRACT"),
    resourceGroups: z.array(z.string().min(1)).min(1),
    message: z.string().trim().min(1).max(1024),
  }).strict(),
  z.object({ state: z.literal("problem"), problem: problemReceiptSchema }).strict(),
]);
export type UploadReceipt = z.infer<typeof uploadReceiptSchema>;

const notificationEventBaseSchema = z.object({
    id: z.uuid(),
    cursor: z.string().min(1).max(2048).optional(),
    type: z.string().min(1).max(256),
    occurredAt: z.iso.datetime({ offset: true }),
    title: z.string().min(1).max(256),
    body: z.string().max(4096).optional(),
    read: z.boolean(),
    data: z.record(z.string(), z.unknown()).optional(),
  });
const notificationCommandProblemSchema = z.object({
  title: z.string().trim().min(1).max(256),
  detail: z.string().max(4096).optional(),
  code: z.string().trim().min(1).max(128).optional(),
  retryable: z.boolean().optional(),
  status: z.number().int().min(400).max(599),
  currentVersion: z.number().int().min(0).optional(),
}).strict();
const notificationCommandEventSchema = z.discriminatedUnion("commandState", [
  notificationEventBaseSchema.extend({
    commandState: z.literal("completed"),
    intentHandle: z.uuid(),
    correlationId: z.uuid(),
  }).strict(),
  notificationEventBaseSchema.extend({
    commandState: z.literal("problem"),
    intentHandle: z.uuid(),
    correlationId: z.uuid(),
    commandProblem: notificationCommandProblemSchema,
  }).strict(),
]);
export const notificationEventSchema = z.union([
  notificationEventBaseSchema.strict(),
  notificationCommandEventSchema,
]);
export type NotificationEvent = z.infer<typeof notificationEventSchema>;

export const notificationConnectionStateSchema = z.object({
  state: z.enum(["connecting", "online", "reconnecting", "unavailable"]),
  changedAt: z.iso.datetime({ offset: true }),
  lastEventAt: z.iso.datetime({ offset: true }).optional(),
}).strict();
export type NotificationConnectionState = z.infer<typeof notificationConnectionStateSchema>;

export const notificationPageSchema = z
  .object({
    items: z.array(notificationEventSchema).max(2_000),
    nextCursor: z.string().min(1).max(2048).optional(),
  })
  .strict();
export type NotificationPage = z.infer<typeof notificationPageSchema>;

export const notificationListResultSchema = z.union([
  notificationPageSchema,
  z.object({
    state: z.literal("unavailable"),
    reason: z.literal("UNAVAILABLE_CONTRACT"),
    resourceGroups: z.array(z.string().min(1)).min(1),
    message: z.string().trim().min(1).max(1024),
  }).strict(),
]);
export type NotificationListResult = z.infer<typeof notificationListResultSchema>;

export interface OccApi {
  profiles: {
    list(): Promise<ServerProfile[]>;
    current(): Promise<ServerProfile | null>;
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
    preflight(input: EvidenceUploadMetadata): Promise<UploadAvailability>;
    begin(input: EvidenceUploadMetadata): Promise<UploadReceipt>;
    append(input: UploadAppendInput): Promise<UploadAppendReceipt>;
    finish(uploadId: string): Promise<UploadReceipt>;
    cancel(uploadId: string): Promise<void>;
    subscribeProgress(listener: (progress: UploadProgress) => void): () => void;
  };
  notifications: {
    list(cursor?: string): Promise<NotificationListResult>;
    subscribe(listener: (event: NotificationEvent) => void): () => void;
    subscribeState(listener: (state: NotificationConnectionState) => void): () => void;
  };
}

export const systemStatusesSchema = z.array(SystemStatusSchema);
