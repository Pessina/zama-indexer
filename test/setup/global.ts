// vitest globalSetup — provisions the local fhEVM stack ONCE before any test and
// tears it down after, then hands the deploy output to the suite via vitest's
// typed provide/inject channel. These are integration tests against a real
// cleartext stack (no mocks), so instead of making the developer start anvil +
// deploy by hand, we:
//   - reuse a chain that's already reachable (the developer owns its lifecycle); or
//   - start an ephemeral anvil (@viem/anvil), deploy the fhEVM host stack + tokens
//     (`pnpm local:deploy`), run the suite, and stop anvil on teardown.
// Requires Foundry (anvil, forge) on PATH and a one-time `pnpm contracts:setup`.
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAnvil } from "@viem/anvil";
import { createPublicClient, http } from "viem";
import type { Address } from "viem";
import { foundry } from "viem/chains";
import type { TestProject } from "vitest/node";
import { LOCAL_RPC } from "../../src/anvil";

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

export default async function globalSetup({
  provide,
}: TestProject): Promise<(() => Promise<void>) | void> {
  let teardown: (() => Promise<void>) | undefined;

  // Reuse a chain the developer is already running; otherwise start an ephemeral
  // anvil, deploy the FHE host stack + tokens, and stop it after the suite.
  if (!(await chainIsUp())) {
    await assertFoundryInstalled();
    const anvil = createAnvil({ port: 8545, chainId: 31337 });
    try {
      await anvil.start();
      // Deploy the host stack + tokens; writes contracts/deployments.json.
      await exec("pnpm local:deploy", { cwd: process.cwd(), maxBuffer: 64 * 1024 * 1024 });
    } catch (err) {
      await anvil.stop().catch(() => {});
      throw new Error(
        "Failed to provision the local fhEVM stack for tests. Ensure the contracts are built " +
          "once via `pnpm contracts:setup`.\n\n" +
          (err as Error).message,
      );
    }
    teardown = async () => {
      await anvil.stop();
    };
  }

  // The deploy output is present either way — read it once and hand the token
  // addresses to the suite via the typed provide/inject channel.
  const deployments = JSON.parse(
    readFileSync(resolve("contracts", "deployments.json"), "utf8"),
  ) as { cUSDT: Address };
  provide("deployments", deployments);

  return teardown;
}

declare module "vitest" {
  export interface ProvidedContext {
    deployments: { cUSDT: Address };
  }
}
