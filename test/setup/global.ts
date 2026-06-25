// vitest globalSetup — provisions the local fhEVM stack ONCE before any test and
// tears it down after, then hands the deploy output to the suite via vitest's
// typed provide/inject channel.
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAnvil } from "@viem/anvil";
import type { Address } from "viem";
import type { TestProject } from "vitest/node";

const exec = promisify(execCb);

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

export default async function globalSetup({ provide }: TestProject): Promise<() => Promise<void>> {
  // The test run owns the chain end to end: always start an ephemeral anvil, deploy the
  // FHE host stack + tokens, and stop it after the suite.
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

  // Read the deploy output once and hand the token addresses to the suite.
  const deployments = JSON.parse(
    readFileSync(resolve("contracts", "deployments.json"), "utf8"),
  ) as { cUSDT: Address };
  provide("deployments", deployments);

  return async () => {
    await anvil.stop();
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    deployments: { cUSDT: Address };
  }
}
