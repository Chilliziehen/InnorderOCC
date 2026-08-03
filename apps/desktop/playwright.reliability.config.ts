import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./smoke",
  testMatch: "reliability.spec.ts",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  outputDir: "./test-results/reliability-artifacts",
  reporter: [
    ["list"],
    ["junit", { outputFile: "test-results/reliability-junit.xml" }],
  ],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
