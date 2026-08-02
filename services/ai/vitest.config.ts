import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["test/*-container.test.mjs", "node_modules/**", "dist/**"],
  },
});
