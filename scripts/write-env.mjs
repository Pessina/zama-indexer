// Generate .env.local for a local (MODE=local) run.
//
// Reads the freshly-deployed confidential-token address from
// contracts/deployments.json; the host-stack + account #0 values are the fixed
// forge-fhevm / Anvil canonical defaults (same on every local deploy). Run by
// `pnpm local:deploy` after the contracts are deployed.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "http://127.0.0.1:8545";

const deployments = JSON.parse(readFileSync(join(ROOT, "contracts/deployments.json"), "utf8"));
const cUSDT = deployments.cUSDT;
if (!cUSDT) throw new Error("cUSDT missing from contracts/deployments.json — run the deploy first");

const env =
  [
    `PONDER_RPC_URL_31337=${RPC}`,
    `SDK_RPC_URL=${RPC}`,
    // Anvil account #0 — the deployer/holder the app deploy wrapped tokens to.
    "PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    `CONFIDENTIAL_TOKEN_ADDRESS=${cUSDT}`,
    // Canonical forge-fhevm host-stack addresses (fixed on every local deploy).
    "ACL_ADDRESS=0x50157CFfD6bBFA2DECe204a89ec419c23ef5755D",
    "EXECUTOR_ADDRESS=0xe3a9105a3a932253A70F126eb1E3b589C643dD24",
    "START_BLOCK=0",
  ].join("\n") + "\n";

writeFileSync(join(ROOT, ".env.local"), env);
console.log(`✓ Wrote .env.local (CONFIDENTIAL_TOKEN_ADDRESS=${cUSDT})`);
