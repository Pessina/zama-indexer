import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/setup/global.ts"],
    // Integration tests share one local chain and drive real decrypt round-trips:
    // run files serially and give hooks room to fund + index before asserting.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
