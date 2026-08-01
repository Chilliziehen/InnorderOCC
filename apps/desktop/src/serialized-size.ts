import { serialize } from "node:v8";

export function serializedSize(value: unknown): number {
  return serialize(value).byteLength;
}
