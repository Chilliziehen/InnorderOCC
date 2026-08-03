import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: path.resolve(__dirname, "src/renderer"),
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, ".vite/renderer/main_window"),
    sourcemap: false,
  },
});
