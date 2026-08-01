import { describe, expect, it, vi } from "vitest";

import { canonicalizeCommandPayload, prepareCommandPayload } from "../src/command-payload";
import {
  COMMAND_INTENT_ACCEPTED_TTL_MS,
  COMMAND_INTENT_MAX_ENTRIES,
  COMMAND_INTENT_RETRYABLE_TTL_MS,
  createCommandIntentRegistry,
  type InternalWorkspaceCommand,
} from "../src/command-intents";
import { workspaceCommandSchema, type CommandReceipt, type WorkspaceCommand } from "../src/desktop-contract";

const handle = "11111111-1111-4111-8111-111111111111";
const keyA = "22222222-2222-4222-8222-222222222222";
const keyB = "33333333-3333-4333-8333-333333333333";
const correlationId = "44444444-4444-4444-8444-444444444444";

function command(overrides: Partial<WorkspaceCommand> = {}): WorkspaceCommand {
  return {
    workspace: "risks",
    operation: "resolve",
    payload: { version: 2, nested: { b: true, a: [null, "x"] } },
    intentHandle: handle,
    ...overrides,
  };
}

describe("strict command JSON payloads", () => {
  it("canonicalizes equivalent JSON objects deterministically", () => {
    const left = { z: 1, nested: { b: true, a: [null, "x"] } };
    const right = { nested: { a: [null, "x"], b: true }, z: 1 };
    expect(canonicalizeCommandPayload(left)).toBe(canonicalizeCommandPayload(right));
    expect(prepareCommandPayload(left)).toEqual({
      success: true,
      payload: left,
      canonical: '{"nested":{"a":[null,"x"],"b":true},"z":1}',
    });
  });

  it.each([
    ["bigint", { value: 1n }],
    ["undefined", { value: undefined }],
    ["function", { value: () => undefined }],
    ["infinity", { value: Number.POSITIVE_INFINITY }],
  ])("cleanly rejects %s values", (_name, payload) => {
    expect(prepareCommandPayload(payload)).toEqual({ success: false });
    expect(() => canonicalizeCommandPayload(payload)).toThrow("Command payload must be strict JSON");
  });

  it("cleanly rejects cyclic values", () => {
    const payload: Record<string, unknown> = {};
    payload.self = payload;
    expect(prepareCommandPayload(payload)).toEqual({ success: false });
    expect(() => canonicalizeCommandPayload(payload)).toThrow("Command payload must be strict JSON");
  });

  it("enforces strict JSON at the renderer IPC input schema", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(workspaceCommandSchema.safeParse({ ...command(), payload: { value: 1n } }).success).toBe(false);
    expect(workspaceCommandSchema.safeParse({ ...command(), payload: cyclic }).success).toBe(false);
  });
});

describe("main command intent registry", () => {
  it("settles accepted intents only when the notification correlation matches", async () => {
    const correlationId = "77777777-7777-4777-8777-777777777777";
    const intents = createCommandIntentRegistry();
    await intents.execute(command(), async () => ({
      state: "accepted",
      commandId: keyA,
      correlationId,
    }));

    expect(intents.settle(handle, keyB)).toBe(false);
    expect(intents.settle(handle, correlationId)).toBe(true);
    expect(intents.settle(handle, correlationId)).toBe(false);
  });

  function registry() {
    const keys = [keyA, keyB];
    return createCommandIntentRegistry({ createIdempotencyKey: () => keys.shift()! });
  }

  it("binds an intent to a main key and hides renderer handles from dependencies", async () => {
    const execute = vi.fn(async (_input: InternalWorkspaceCommand): Promise<CommandReceipt> => ({
      state: "completed", commandId: keyA, correlationId,
    }));
    await registry().execute(command(), execute);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      workspace: "risks",
      operation: "resolve",
      payload: command().payload,
      idempotencyKey: keyA,
    }));
    const internal = execute.mock.calls[0]![0] as InternalWorkspaceCommand;
    expect(internal).not.toHaveProperty("intentHandle");
  });

  it("reuses the key after transport failure for the exact canonical payload", async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({ state: "completed", commandId: keyA, correlationId });
    const intents = registry();
    await expect(intents.execute(command(), execute)).rejects.toThrow("timeout");
    await intents.execute(command({ payload: { nested: { a: [null, "x"], b: true }, version: 2 } }), execute);
    expect(execute.mock.calls[0]![0].idempotencyKey).toBe(keyA);
    expect(execute.mock.calls[1]![0].idempotencyKey).toBe(keyA);
  });

  it("rejects operation or payload changes under the same handle", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("timeout"));
    const intents = registry();
    await expect(intents.execute(command(), execute)).rejects.toThrow("timeout");
    await expect(intents.execute(command({ payload: { version: 3 } }), execute)).rejects.toThrow("Command intent mismatch");
    await expect(intents.execute(command({ operation: "assign" }), execute)).rejects.toThrow("Command intent mismatch");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("retains accepted and retryable problem intents", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ state: "accepted", commandId: keyA, correlationId })
      .mockResolvedValueOnce({ state: "problem", problem: { title: "Timeout", code: "TIMEOUT", status: 504, retryable: true } })
      .mockResolvedValueOnce({ state: "completed", commandId: keyA, correlationId });
    const intents = registry();
    await intents.execute(command(), execute);
    await intents.execute(command(), execute);
    await intents.execute(command(), execute);
    expect(execute.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([keyA, keyA, keyA]);
  });

  it.each([
    { state: "completed", commandId: keyA, correlationId },
    { state: "problem", problem: { title: "Rejected", code: "REJECTED", status: 422, retryable: false } },
    { state: "conflict", currentVersion: 3, correlationId },
    { state: "unavailable", reason: "UNAVAILABLE_CONTRACT", resourceGroups: ["/risks"], message: "Risk commands unavailable" },
  ] as CommandReceipt[])("replays exact terminal $state receipts without invoking again", async (receipt) => {
    const execute = vi.fn().mockResolvedValueOnce(receipt).mockResolvedValueOnce(receipt);
    const intents = registry();
    await expect(intents.execute(command(), execute)).resolves.toEqual(receipt);
    await expect(intents.execute(command(), execute)).resolves.toEqual(receipt);
    expect(execute.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([keyA]);
    await expect(intents.execute(command({ payload: { version: 3 } }), execute)).rejects.toThrow("Command intent mismatch");
    await intents.execute(command({ intentHandle: keyB }), execute);
    expect(execute.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([keyA, keyB]);
  });

  it("retains an intent when a dependency returns an invalid receipt", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ state: "accepted" })
      .mockResolvedValueOnce({ state: "completed", commandId: keyA, correlationId });
    const intents = registry();
    await expect(intents.execute(command(), execute)).rejects.toThrow();
    await intents.execute(command(), execute);
    expect(execute.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([keyA, keyA]);
  });

  it("shares one in-flight promise and dependency invocation for matching calls", async () => {
    let resolve!: (receipt: CommandReceipt) => void;
    const execute = vi.fn(() => new Promise<CommandReceipt>((done) => void (resolve = done)));
    const intents = registry();
    const first = intents.execute(command(), execute);
    const second = intents.execute(command(), execute);
    expect(second).toBe(first);
    expect(execute).toHaveBeenCalledOnce();
    resolve({ state: "completed", commandId: keyA, correlationId });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    const next = vi.fn().mockResolvedValue({ state: "completed", commandId: keyB, correlationId });
    await expect(intents.execute(command(), next)).resolves.toEqual({ state: "completed", commandId: keyA, correlationId });
    expect(next).not.toHaveBeenCalled();
  });

  it("shares a failed in-flight call then reuses its key on retry", async () => {
    let reject!: (error: Error) => void;
    const execute = vi.fn(() => new Promise<CommandReceipt>((_resolve, fail) => void (reject = fail)));
    const intents = registry();
    const first = intents.execute(command(), execute);
    const second = intents.execute(command(), execute);
    reject(new Error("timeout"));
    await expect(first).rejects.toThrow("timeout");
    await expect(second).rejects.toThrow("timeout");
    const retry = vi.fn().mockResolvedValue({ state: "completed", commandId: keyA, correlationId });
    await intents.execute(command(), retry);
    expect(retry.mock.calls[0]![0].idempotencyKey).toBe(keyA);
  });

  it("settles accepted bindings into terminal tombstones without allocating a new key", async () => {
    const execute = vi.fn().mockResolvedValue({ state: "accepted", commandId: keyA, correlationId });
    const intents = registry();
    await intents.execute(command(), execute);
    expect(intents.settle(handle)).toBe(true);
    expect(intents.settle(handle)).toBe(false);
    expect(() => intents.settle("not-a-uuid")).toThrow();
    await expect(intents.execute(command(), execute)).resolves.toEqual({ state: "completed", commandId: keyA, correlationId });
    await expect(intents.execute(command({ payload: { version: 3 } }), execute)).rejects.toThrow("Command intent mismatch");
    await expect(intents.execute(command({ targetId: "different-target" }), execute)).rejects.toThrow("Command intent mismatch");
    expect(execute.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([keyA]);
  });

  it("expires notification-settled terminal tombstones after TTL", async () => {
    let now = 1_000;
    const keys = [keyA, keyB];
    const intents = createCommandIntentRegistry({ now: () => now, createIdempotencyKey: () => keys.shift()! });
    const execute = vi.fn().mockResolvedValue({ state: "accepted", commandId: keyA, correlationId });
    await intents.execute(command(), execute);
    expect(intents.settle(handle, correlationId)).toBe(true);
    now += COMMAND_INTENT_ACCEPTED_TTL_MS + 1;
    await intents.execute(command(), execute);
    expect(execute.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([keyA, keyB]);
  });

  it("does not settle in-flight or retryable bindings", async () => {
    let reject!: (error: Error) => void;
    const execute = vi.fn(() => new Promise<CommandReceipt>((_resolve, fail) => void (reject = fail)));
    const intents = registry();
    const pending = intents.execute(command(), execute);
    expect(intents.settle(handle)).toBe(false);
    reject(new Error("offline"));
    await expect(pending).rejects.toThrow("offline");
    expect(intents.settle(handle)).toBe(false);
    const retry = vi.fn().mockResolvedValue({ state: "completed", commandId: keyA, correlationId });
    await intents.execute(command(), retry);
    expect(retry.mock.calls[0]![0].idempotencyKey).toBe(keyA);
  });

  it("expires accepted bindings after the documented TTL", async () => {
    let now = 1_000;
    const keys = [keyA, keyB];
    const intents = createCommandIntentRegistry({
      now: () => now,
      createIdempotencyKey: () => keys.shift()!,
    });
    const execute = vi.fn().mockResolvedValue({ state: "accepted", commandId: keyA, correlationId });
    await intents.execute(command(), execute);
    now += COMMAND_INTENT_ACCEPTED_TTL_MS + 1;
    await intents.execute(command(), execute);
    expect(execute.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([keyA, keyB]);
  });

  it("expires terminal replay receipts and recovers registry capacity", async () => {
    let now = 1_000;
    const keys = [keyA, keyB];
    const intents = createCommandIntentRegistry({
      now: () => now,
      maxEntries: 1,
      createIdempotencyKey: () => keys.shift()!,
    });
    const execute = vi.fn().mockResolvedValue({ state: "completed", commandId: keyA, correlationId });
    await intents.execute(command(), execute);
    await expect(intents.execute(command({ intentHandle: keyB }), execute)).rejects.toThrow("capacity exceeded");
    now += COMMAND_INTENT_ACCEPTED_TTL_MS + 1;
    await intents.execute(command({ intentHandle: keyB }), execute);
    expect(execute.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([keyA, keyB]);
  });

  it("retains retryable bindings and their key until the documented TTL", async () => {
    let now = 1_000;
    const keys = [keyA, keyB];
    const intents = createCommandIntentRegistry({
      now: () => now,
      createIdempotencyKey: () => keys.shift()!,
    });
    const execute = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(intents.execute(command(), execute)).rejects.toThrow("offline");
    now += COMMAND_INTENT_RETRYABLE_TTL_MS - 1;
    await expect(intents.execute(command(), execute)).rejects.toThrow("offline");

    expect(execute.mock.calls.map(([input]) => input.idempotencyKey)).toEqual([keyA, keyA]);
  });

  it("expires idle retryable bindings so repeated failures recover registry capacity", async () => {
    let now = 1_000;
    const intents = createCommandIntentRegistry({
      now: () => now,
      maxEntries: 2,
      createIdempotencyKey: () => crypto.randomUUID(),
    });
    const execute = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(intents.execute(command({ intentHandle: handle }), execute)).rejects.toThrow("offline");
    await expect(intents.execute(command({ intentHandle: keyA }), execute)).rejects.toThrow("offline");
    now += COMMAND_INTENT_RETRYABLE_TTL_MS + 1;
    await expect(intents.execute(command({ intentHandle: keyB }), execute)).rejects.toThrow("offline");

    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("recovers the production cap after 1,000 failed intents expire", async () => {
    let now = 1_000;
    const intents = createCommandIntentRegistry({ now: () => now });
    const execute = vi.fn().mockRejectedValue(new Error("offline"));

    for (let index = 0; index < COMMAND_INTENT_MAX_ENTRIES; index += 1) {
      await expect(intents.execute(command({ intentHandle: crypto.randomUUID() }), execute)).rejects.toThrow("offline");
    }
    await expect(intents.execute(command({ intentHandle: crypto.randomUUID() }), execute)).rejects.toThrow("Command intent registry capacity exceeded");

    now += COMMAND_INTENT_RETRYABLE_TTL_MS + 1;
    await expect(intents.execute(command({ intentHandle: crypto.randomUUID() }), execute)).rejects.toThrow("offline");
    expect(execute).toHaveBeenCalledTimes(COMMAND_INTENT_MAX_ENTRIES + 1);
  });

  it("does not expire a retryable binding while its dependency request is in flight", async () => {
    let now = 1_000;
    let reject!: (error: Error) => void;
    const execute = vi.fn(() => new Promise<CommandReceipt>((_resolve, fail) => void (reject = fail)));
    const intents = createCommandIntentRegistry({
      now: () => now,
      maxEntries: 1,
      createIdempotencyKey: () => keyA,
    });
    const pending = intents.execute(command(), execute);

    now += COMMAND_INTENT_RETRYABLE_TTL_MS + 1;
    await expect(intents.execute(command({ intentHandle: keyB }), execute)).rejects.toThrow("Command intent registry capacity exceeded");
    expect(execute).toHaveBeenCalledOnce();

    reject(new Error("offline"));
    await expect(pending).rejects.toThrow("offline");
  });

  it("enforces the documented registry entry cap", async () => {
    const intents = createCommandIntentRegistry({
      maxEntries: 2,
      createIdempotencyKey: () => crypto.randomUUID(),
    });
    const execute = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(intents.execute(command({ intentHandle: handle }), execute)).rejects.toThrow("offline");
    await expect(intents.execute(command({ intentHandle: keyA }), execute)).rejects.toThrow("offline");
    await expect(intents.execute(command({ intentHandle: keyB }), execute)).rejects.toThrow("Command intent registry capacity exceeded");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(COMMAND_INTENT_MAX_ENTRIES).toBeGreaterThan(2);
  });

  it("hashes a canonical identity tuple without NUL delimiter collisions", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("offline"));
    const intents = registry();
    await expect(intents.execute(command({ workspace: "a\u0000b", operation: "c" }), execute)).rejects.toThrow("offline");
    await expect(intents.execute(command({ workspace: "a", operation: "b\u0000c" }), execute)).rejects.toThrow("Command intent mismatch");
    expect(execute).toHaveBeenCalledOnce();
  });
});
