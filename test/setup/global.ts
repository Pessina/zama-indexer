// vitest globalSetup — provisions the local fhEVM stack ONCE before any test and
// tears it down after. These are integration tests against a real cleartext stack
// (no mocks), so instead of making the developer start anvil + deploy by hand, we:
//   - reuse a chain that's already reachable (the developer owns its lifecycle); or
//   - start an ephemeral anvil (@viem/anvil), deploy the fhEVM host stack + tokens
//     (`pnpm local:deploy`), run the suite, and stop anvil on teardown.
// Requires Foundry (anvil, forge) on PATH and a one-time `pnpm contracts:setup`.
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { createAnvil } from "@viem/anvil";
import { createPublicClient, http } from "viem";
import { foundry } from "viem/chains";
import { LOCAL_RPC } from "../helpers/local-sdk";
import { loadDeployments } from "../helpers/deployments";

const exec = promisify(execCb);
const client = createPublicClient({ chain: foundry, transport: http(LOCAL_RPC) });

async function chainIsUp(): Promise<boolean> {
  try {
    await client.getChainId();
    return true;
  } catch {
    return false;
  }
}

// @viem/anvil surfaces a missing `anvil` binary as an *unhandled rejection* (the
// spawn error escapes start()), so check the binary ourselves first — promisified
// exec routes ENOENT into a catchable rejection, giving a clean, actionable error.
async function assertFoundryInstalled(): Promise<void> {
  try {
    await exec("anvil --version");
  } catch {
    throw new Error(
      "Foundry's `anvil` was not found on PATH. Install Foundry (https://getfoundry.sh), " +
        "then build the contracts once with `pnpm contracts:setup`.",
    );
  }
}

export default async function globalSetup(): Promise<(() => Promise<void>) | void> {
  // A chain the developer is already running — reuse it as-is.
  if (await chainIsUp()) {
    loadDeployments();
    return;
  }

  await assertFoundryInstalled();

  // Start an ephemeral anvil for this run. @viem/anvil owns the process lifecycle:
  // start() resolves once it's accepting connections, stop() shuts it down.
  const anvil = createAnvil({ port: 8545, chainId: 31337 });
  try {
    await anvil.start();
    // Deploy the FHE host stack + test tokens; writes contracts/deployments.json + .env.local.
    await exec("pnpm local:deploy", { cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 });
    loadDeployments();
  } catch (err) {
    await anvil.stop().catch(() => {});
    throw new Error(
      "Failed to provision the local fhEVM stack for tests. Ensure the contracts are built " +
        "once via `pnpm contracts:setup`.\n\n" +
        (err as Error).message,
    );
  }

  // Teardown: stop the anvil we started (vitest awaits this after the suite).
  return async () => {
    await anvil.stop();
  };
}
