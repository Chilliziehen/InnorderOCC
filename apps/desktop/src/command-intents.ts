import { createHash } from "node:crypto";
import { z } from "zod";

import { commandReceiptSchema, type CommandReceipt, type WorkspaceCommand } from "./desktop-contract";
import { prepareCommandPayload, type JsonObject } from "./command-payload";

export interface InternalWorkspaceCommand {
  readonly workspace: string;
  readonly operation: string;
  readonly targetId?: string;
  readonly payload: JsonObject;
  readonly idempotencyKey: string;
}

interface IntentBinding {
  readonly identityHash: string;
  readonly payloadHash: string;
  readonly idempotencyKey: string;
  state: "retryable" | "accepted";
  retryableAt?: number;
  acceptedAt?: number;
  inFlight?: Promise<CommandReceipt>;
}

interface CommandIntentRegistryOptions {
  readonly createIdempotencyKey?: () => string;
  readonly now?: () => number;
  readonly acceptedTtlMs?: number;
  readonly retryableTtlMs?: number;
  readonly maxEntries?: number;
}

export interface CommandIntentRegistry {
  execute(
    command: WorkspaceCommand,
    invoke: (command: InternalWorkspaceCommand) => Promise<CommandReceipt>,
  ): Promise<CommandReceipt>;
  settle(intentHandle: string): boolean;
}

/** Accepted bindings expire after 15 minutes if no terminal notification settles them. */
export const COMMAND_INTENT_ACCEPTED_TTL_MS = 15 * 60 * 1_000;
/** Idle retryable bindings retain their key for 15 minutes before releasing capacity. */
export const COMMAND_INTENT_RETRYABLE_TTL_MS = 15 * 60 * 1_000;
/** The hard entry cap bounds accepted and retryable bindings during prolonged outages. */
export const COMMAND_INTENT_MAX_ENTRIES = 1_000;
const intentHandleSchema = z.uuid();

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function identityHash(command: WorkspaceCommand): string {
  return sha256(JSON.stringify([
    command.workspace,
    command.operation,
    command.targetId ?? null,
  ]));
}

export function createCommandIntentRegistry(
  options: CommandIntentRegistryOptions = {},
): CommandIntentRegistry {
  const bindings = new Map<string, IntentBinding>();
  const createIdempotencyKey = options.createIdempotencyKey ?? (() => crypto.randomUUID());
  const now = options.now ?? Date.now;
  const acceptedTtlMs = options.acceptedTtlMs ?? COMMAND_INTENT_ACCEPTED_TTL_MS;
  const retryableTtlMs = options.retryableTtlMs ?? COMMAND_INTENT_RETRYABLE_TTL_MS;
  const maxEntries = options.maxEntries ?? COMMAND_INTENT_MAX_ENTRIES;
  const cleanupExpired = () => {
    const currentTime = now();
    for (const [handle, binding] of bindings) {
      const expiredAccepted = binding.state === "accepted" &&
        binding.acceptedAt !== undefined &&
        currentTime - binding.acceptedAt >= acceptedTtlMs;
      const expiredRetryable = binding.state === "retryable" &&
        binding.retryableAt !== undefined &&
        currentTime - binding.retryableAt >= retryableTtlMs;
      if (binding.inFlight === undefined && (expiredAccepted || expiredRetryable)) {
        bindings.delete(handle);
      }
    }
  };
  return {
    execute(command, invoke) {
      const prepared = prepareCommandPayload(command.payload ?? {});
      if (!prepared.success) return Promise.reject(new Error("Command payload must be strict JSON"));
      cleanupExpired();
      const identity = identityHash(command);
      const hash = sha256(prepared.canonical);
      let binding = bindings.get(command.intentHandle);
      if (binding && (binding.identityHash !== identity || binding.payloadHash !== hash)) {
        return Promise.reject(new Error("Command intent mismatch"));
      }
      if (!binding) {
        if (bindings.size >= maxEntries) {
          return Promise.reject(new Error("Command intent registry capacity exceeded"));
        }
        binding = {
          identityHash: identity,
          payloadHash: hash,
          idempotencyKey: createIdempotencyKey(),
          state: "retryable",
          retryableAt: now(),
        };
        bindings.set(command.intentHandle, binding);
      }
      if (binding.inFlight) return binding.inFlight;
      const internal: InternalWorkspaceCommand = {
        workspace: command.workspace,
        operation: command.operation,
        payload: prepared.payload,
        idempotencyKey: binding.idempotencyKey,
        ...(command.targetId ? { targetId: command.targetId } : {}),
      };
      let resolveFlight!: (receipt: CommandReceipt) => void;
      let rejectFlight!: (error: unknown) => void;
      const inFlight = new Promise<CommandReceipt>((resolve, reject) => {
        resolveFlight = resolve;
        rejectFlight = reject;
      });
      binding.inFlight = inFlight;
      const clearInFlight = () => {
        if (bindings.get(command.intentHandle) === binding && binding.inFlight === inFlight) {
          delete binding.inFlight;
        }
      };
      const resolveReceipt = (rawReceipt: CommandReceipt) => {
        try {
          const receipt = commandReceiptSchema.parse(rawReceipt);
          if (receipt.state === "accepted") {
            binding.state = "accepted";
            binding.acceptedAt = now();
            delete binding.retryableAt;
          } else if (receipt.state === "problem" && receipt.problem.retryable === true) {
            binding.state = "retryable";
            binding.retryableAt = now();
            delete binding.acceptedAt;
          } else {
            bindings.delete(command.intentHandle);
          }
          clearInFlight();
          resolveFlight(receipt);
        } catch (error) {
          clearInFlight();
          binding.retryableAt = now();
          rejectFlight(error);
        }
      };
      const rejectTransport = (error: unknown) => {
        clearInFlight();
        binding.retryableAt = now();
        rejectFlight(error);
      };
      try {
        invoke(internal).then(resolveReceipt, rejectTransport);
      } catch (error) {
        rejectTransport(error);
      }
      return inFlight;
    },
    settle(intentHandle) {
      const parsed = intentHandleSchema.parse(intentHandle);
      const binding = bindings.get(parsed);
      if (!binding || binding.state !== "accepted" || binding.inFlight !== undefined) {
        return false;
      }
      return bindings.delete(parsed);
    },
  };
}
