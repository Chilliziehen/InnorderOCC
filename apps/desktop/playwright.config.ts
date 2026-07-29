import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./smoke",
  timeout: 45_000,
  workers: 1,
  fullyParallel: false,
  reporter: "list",
});
