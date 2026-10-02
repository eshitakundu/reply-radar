import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
  use: { headless: true, viewport: { width: 900, height: 1000 }, screenshot: "only-on-failure" },
  outputDir: "e2e/results",
});
