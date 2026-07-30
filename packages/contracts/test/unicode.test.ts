import { describe, expect, it } from "vitest";

import { hasUnicodeCodePointLengthWithin } from "../src/unicode.js";

describe("hasUnicodeCodePointLengthWithin", () => {
  it("counts Unicode code points rather than UTF-16 code units", () => {
    expect(hasUnicodeCodePointLengthWithin("😀".repeat(2), 2, 2)).toBe(true);
    expect(hasUnicodeCodePointLengthWithin("😀".repeat(2), 3, 3)).toBe(false);
  });

  it("stops immediately after reading max plus one code points", () => {
    let iterations = 0;
    function* guardedCodePoints(): Generator<string> {
      for (let index = 0; index < 4; index += 1) {
        iterations += 1;
        yield "😀";
      }
      throw new Error("iterated beyond max plus one");
    }

    expect(hasUnicodeCodePointLengthWithin(guardedCodePoints(), 0, 3)).toBe(false);
    expect(iterations).toBe(4);
  });
});
