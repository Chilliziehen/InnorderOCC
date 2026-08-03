import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./smoke",
  timeout: 90_000,
  expect: { timeout: 10_000, toHaveScreenshot: { maxDiffPixelRatio: 0.001 } },
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  outputDir: "./test-results/artifacts",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
    ["junit", { outputFile: "test-results/junit.xml" }],
  ],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
