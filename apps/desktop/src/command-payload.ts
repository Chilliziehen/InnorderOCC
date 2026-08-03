import { z } from "zod";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown, ancestors: Set<object>): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || (!Array.isArray(value) && !isPlainObject(value))) return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((child) => isJsonValue(child, ancestors))
    : Object.values(value).every((child) => isJsonValue(child, ancestors));
  ancestors.delete(value);
  return valid;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) && isPlainObject(value) && isJsonValue(value, new Set());
}

export const commandPayloadSchema = z.custom<JsonObject>(isJsonObject, {
  message: "Command payload must be strict JSON",
});

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortJson(value[key]!)]),
    );
  }
  return value;
}

export type PreparedCommandPayload =
  | { readonly success: true; readonly payload: JsonObject; readonly canonical: string }
  | { readonly success: false };

export function prepareCommandPayload(input: unknown): PreparedCommandPayload {
  const parsed = commandPayloadSchema.safeParse(input);
  if (!parsed.success) return { success: false };
  return {
    success: true,
    payload: parsed.data,
    canonical: JSON.stringify(sortJson(parsed.data)),
  };
}

export function canonicalizeCommandPayload(input: unknown): string {
  const prepared = prepareCommandPayload(input);
  if (!prepared.success) throw new Error("Command payload must be strict JSON");
  return prepared.canonical;
}
