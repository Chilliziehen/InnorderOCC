import { createHash } from "node:crypto";

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
  readonly operation: string;
  readonly payloadHash: string;
  readonly idempotencyKey: string;
}

interface CommandIntentRegistryOptions {
  readonly createIdempotencyKey?: () => string;
}

export interface CommandIntentRegistry {
  execute(
    command: WorkspaceCommand,
    invoke: (command: InternalWorkspaceCommand) => Promise<CommandReceipt>,
  ): Promise<CommandReceipt>;
}

function operationIdentity(command: WorkspaceCommand): string {
  return `${command.workspace}\u0000${command.operation}\u0000${command.targetId ?? ""}`;
}

function payloadHash(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function retainsIntent(receipt: CommandReceipt): boolean {
  return receipt.state === "accepted" || (
    receipt.state === "problem" && receipt.problem.retryable === true
  );
}

export function createCommandIntentRegistry(
  options: CommandIntentRegistryOptions = {},
): CommandIntentRegistry {
  const bindings = new Map<string, IntentBinding>();
  const createIdempotencyKey = options.createIdempotencyKey ?? (() => crypto.randomUUID());
  return {
    async execute(command, invoke) {
      const prepared = prepareCommandPayload(command.payload ?? {});
      if (!prepared.success) throw new Error("Command payload must be strict JSON");
      const operation = operationIdentity(command);
      const hash = payloadHash(prepared.canonical);
      let binding = bindings.get(command.intentHandle);
      if (binding && (binding.operation !== operation || binding.payloadHash !== hash)) {
        throw new Error("Command intent mismatch");
      }
      if (!binding) {
        binding = { operation, payloadHash: hash, idempotencyKey: createIdempotencyKey() };
        bindings.set(command.intentHandle, binding);
      }
      const internal: InternalWorkspaceCommand = {
        workspace: command.workspace,
        operation: command.operation,
        payload: prepared.payload,
        idempotencyKey: binding.idempotencyKey,
        ...(command.targetId ? { targetId: command.targetId } : {}),
      };
      const receipt = commandReceiptSchema.parse(await invoke(internal));
      if (!retainsIntent(receipt)) bindings.delete(command.intentHandle);
      return receipt;
    },
  };
}
