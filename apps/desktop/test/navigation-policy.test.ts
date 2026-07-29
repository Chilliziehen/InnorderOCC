import { describe, expect, it } from "vitest";

import { isAllowedNavigation } from "../src/navigation-policy";

describe("renderer navigation policy", () => {
  it("allows only the configured renderer document", () => {
    const rendererUrl = "file:///D:/OCC/.vite/renderer/main_window/index.html";

    expect(isAllowedNavigation(rendererUrl, rendererUrl)).toBe(true);
    expect(isAllowedNavigation(rendererUrl, "https://example.com/")).toBe(false);
    expect(isAllowedNavigation(rendererUrl, `${rendererUrl}?redirect=1`)).toBe(false);
    expect(isAllowedNavigation(rendererUrl, "not a url")).toBe(false);
  });
});
