import { z } from "zod";

export const hasUnicodeCodePointLengthWithin = (
  value: Iterable<string>,
  min: number,
  max: number,
): boolean => {
  let length = 0;

  for (const _codePoint of value) {
    length += 1;
    if (length > max) return false;
  }

  return length >= min;
};

export const unicodeBoundedStringSchema = (min: number, max: number) =>
  z.string().refine((value) => hasUnicodeCodePointLengthWithin(value, min, max));
