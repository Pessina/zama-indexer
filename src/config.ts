// Centralized, validated configuration — the single module that reads process.env.
//
// Local-only: Anvil + forge-fhevm + the SDK's cleartext() transport. Deliberately
// imports NO @zama-fhe/sdk code, so ponder.config.ts can import it at codegen time
// without pulling the SDK into the config-load path. Every env read lives here;
// everything else imports typed, validated values.
import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

// Well-known Anvil account #0 — a public dev key (never a real secret). The default
// holder so the local stack is zero-config.
const ANVIL_ACCT0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
// forge-fhevm's canonical local ACL (matches the SDK `hardhat` chain preset).
const LOCAL_ACL = "0x50157CFfD6bBFA2DECe204a89ec419c23ef5755D";
const ZERO = "0x0000000000000000000000000000000000000000";

const hexKey = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected a 0x 32-byte private key");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 0x 20-byte address");

const schema = z.object({
  // RPC for both Ponder and the SDK's viem client (local Anvil).
  PONDER_RPC_URL_31337: z.string().default("http://127.0.0.1:8545"),
  // Holder/delegate EOA. Defaults to Anvil acct #0 so local runs need no secret.
  PRIVATE_KEY: hexKey.default(ANVIL_ACCT0),
  // The ERC-7984 confidential token to index (written by `pnpm local:deploy`).
  CONFIDENTIAL_TOKEN_ADDRESS: address.default(ZERO),
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

export const CHAIN_ID = 31337;
export const RPC_URL = env.PONDER_RPC_URL_31337;
export const PRIVATE_KEY = env.PRIVATE_KEY as Hex;
export const TOKEN_ADDRESS = env.CONFIDENTIAL_TOKEN_ADDRESS as Address;
export const ACL_ADDRESS = env.ACL_ADDRESS as Address;
export const EXECUTOR_ADDRESS = env.EXECUTOR_ADDRESS as Address | undefined;
export const START_BLOCK = env.START_BLOCK;
export const ACL_START_BLOCK = env.ACL_START_BLOCK ?? env.START_BLOCK;

// Derived ONCE from PRIVATE_KEY so the decrypt seam's signer and the ACL delegation
// filter can never drift apart (the silent-backfill-failure footgun this prevents).
export const holderAddress: Address = privateKeyToAccount(PRIVATE_KEY).address;
