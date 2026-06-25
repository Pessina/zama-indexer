import { defineConfig } from "vitest/config";

// Fast, dependency-free unit tests — no local chain, no globalSetup. The decrypt
// error classifier (`classifyDecryptError` in src/utils/zama.ts) is a pure function,
// so it is tested against constructed SDK error instances with no anvil/stack.
// `pnpm test` still runs everything (these included) via vitest.config.ts; this is
// the fast TDD loop and a CI lane that needs no Foundry.
export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts"],
  },
});
