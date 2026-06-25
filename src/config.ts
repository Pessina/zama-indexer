// Centralized, validated configuration — the single module that reads process.env.
//
// Local-only: Anvil + forge-fhevm + the SDK's cleartext() transport. Deliberately
// imports NO @zama-fhe/sdk code, so ponder.config.ts can import it at codegen time
// without pulling the SDK into the config-load path. Every env read lives here;
// everything else imports the single, typed, validated `config` object.
//
// The confidential-token address is the one value that isn't a fixed local constant
// (it comes from the local deploy), so it's read from contracts/deployments.json —
// the deterministic, checked-in artifact the deploy writes and the tests consume.
// Missing/invalid → throw: an indexer with no token to watch is a misconfiguration.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { foundry } from "viem/chains";

import { ANVIL_KEYS } from "./anvil";

// forge-fhevm's canonical local ACL (matches the SDK `hardhat` chain preset).
const LOCAL_ACL = "0x50157CFfD6bBFA2DECe204a89ec419c23ef5755D";

const hexKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 0x 32-byte private key");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 0x 20-byte address");

const schema = z.object({
  // RPC for both Ponder and the SDK's viem client (local Anvil).
  PONDER_RPC_URL_31337: z.string().default("http://127.0.0.1:8545"),
  // Holder/delegate EOA. Defaults to Anvil acct #0 so local runs need no secret.
  PRIVATE_KEY: hexKey.default(ANVIL_KEYS.acct0),
  // Protocol ACL contract (delegation events + decrypt authorization).
  ACL_ADDRESS: address.default(LOCAL_ACL),
  // fhEVM executor (cleartext transport). Defaults to the SDK `hardhat` preset.
  EXECUTOR_ADDRESS: address.optional(),
  START_BLOCK: z.coerce.number().int().nonnegative().default(0),
  ACL_START_BLOCK: z.coerce.number().int().nonnegative().optional(),
});

const result = schema.safeParse(process.env);
if (!result.success) {
  const detail = result.error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  throw new Error(`Invalid environment configuration:\n${detail}`);
}
const env = result.data;
const privateKey = env.PRIVATE_KEY as Hex;

// The confidential token to index, read from the deploy artifact. deployments.json is
// deterministic and checked in, so it's present after any deploy; a missing or malformed
// entry is a misconfiguration — we throw rather than index the zero address.
function readTokenAddress(): Address {
  const path = resolve("contracts", "deployments.json");
  let cUSDT: unknown;
  try {
    cUSDT = (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>).cUSDT;
  } catch (err) {
    throw new Error(`Could not read ${path} — run \`pnpm local:deploy\` first.\n${String(err)}`);
  }
  if (typeof cUSDT !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(cUSDT))
    throw new Error(`No valid cUSDT address in ${path} — re-run \`pnpm local:deploy\`.`);
  return cUSDT as Address;
}

const tokenAddress = readTokenAddress();

// The single validated config object — every consumer imports this and reads
// `config.*`. `as const` makes it readonly, so nothing can mutate shared config
// after load. `holderAddress` is derived ONCE from `privateKey` so the decrypt
// seam's signer and the ACL delegation filter can never drift apart (the
// silent-backfill-failure footgun this prevents).
export const config = {
  chainId: foundry.id,
  rpcUrl: env.PONDER_RPC_URL_31337,
  privateKey,
  tokenAddress,
  aclAddress: env.ACL_ADDRESS as Address,
  executorAddress: env.EXECUTOR_ADDRESS as Address | undefined,
  startBlock: env.START_BLOCK,
  aclStartBlock: env.ACL_START_BLOCK ?? env.START_BLOCK,
  holderAddress: privateKeyToAccount(privateKey).address,
} as const;
