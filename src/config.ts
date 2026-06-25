// Centralized, validated configuration — the one place the app reads and validates its own env.
// Imports NO @zama-fhe/sdk code so ponder.config.ts can load it at codegen time. Every
// app-level env read lives here; everything else imports the typed, validated `config` object
// (Ponder reads its own vars — PONDER_RPC_URL_*, DATABASE_URL, PORT — directly). The
// token address is read from contracts/deployments.json (the deploy artifact) — missing or
// invalid throws, since an indexer with no token to watch is a misconfiguration.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { foundry } from "viem/chains";

import { ANVIL_KEYS } from "./anvil";

const LOCAL_ACL = "0x50157CFfD6bBFA2DECe204a89ec419c23ef5755D" as Address;

const hexKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 0x 32-byte private key");

const schema = z.object({
  PONDER_RPC_URL_31337: z.string().default("http://127.0.0.1:8545"),
  // Holder/delegate EOA. Defaults to Anvil acct #0 so local runs need no secret.
  PRIVATE_KEY: hexKey.default(ANVIL_KEYS.acct0),
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

// Read the confidential token to index from the deploy artifact (deterministic, checked
// in). A missing or malformed entry is a misconfiguration — throw rather than index 0x0.
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

export const config = {
  chainId: foundry.id,
  rpcUrl: env.PONDER_RPC_URL_31337,
  privateKey,
  tokenAddress,
  aclAddress: LOCAL_ACL, // canonical on the local stack; the address Ponder indexes the ACL at
  startBlock: 0, // fresh local chain — the host stack + token deploy in the first blocks
  holderAddress: privateKeyToAccount(privateKey).address,
} as const;
