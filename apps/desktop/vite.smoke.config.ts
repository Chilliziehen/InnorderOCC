import path from "node:path";

import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: [{
      find: path.resolve(__dirname, "src/runtime-adapter.ts"),
      replacement: path.resolve(__dirname, "smoke/runtime/smoke-runtime-adapter.ts"),
    }],
  },
  build: { sourcemap: false },
});
