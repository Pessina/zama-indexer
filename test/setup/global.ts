// vitest globalSetup — runs once before any test. These are integration tests against
// a real local fhEVM stack (no mocks), so fail fast with the exact commands to start it
// rather than letting individual tests time out on a dead RPC.
import { createPublicClient, http } from "viem";
import { foundry } from "viem/chains";
import { LOCAL_RPC } from "../helpers/local-sdk";
import { loadDeployments } from "../helpers/deployments";

export default async function globalSetup(): Promise<void> {
  const client = createPublicClient({ chain: foundry, transport: http(LOCAL_RPC) });
  try {
    await client.getChainId();
  } catch {
    throw new Error(
      `No chain reachable at ${LOCAL_RPC}. Start the local stack first:\n` +
        `  pnpm chain         # terminal 1 — anvil\n` +
        `  pnpm local:deploy  # terminal 2 — host stack + tokens\n`,
    );
  }
  // Throws a clear error if the deploy hasn't run (contracts/deployments.json missing).
  loadDeployments();
}
