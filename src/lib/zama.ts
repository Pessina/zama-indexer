// The decrypt seam — the ONLY module that touches @zama-fhe/sdk.
//
// It builds one process-wide ZamaSDK and turns an encrypted amount handle into
// either cleartext or a status the indexer can persist. The high-level decrypt
// API is identical on local and Sepolia; only the transport differs:
//   - local   → cleartext() against Anvil + forge-fhevm (reads the on-chain
//               mock executor; enforces real ACL). No hosted relayer.
//   - sepolia → node() against the hosted relayer (real FHE).
// Tests mock this module, so they never construct a real SDK.

import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry, sepolia as viemSepolia } from "viem/chains";
import {
  DecryptionFailedError,
  DelegationNotPropagatedError,
  MemoryStorage,
  NoCiphertextError,
  RelayerRequestFailedError,
  ZamaSDK,
} from "@zama-fhe/sdk";
import { hardhat, sepolia, type FheChain } from "@zama-fhe/sdk/chains";
import { createConfig } from "@zama-fhe/sdk/viem";
import { cleartext, node } from "@zama-fhe/sdk/node";

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const isLocal = process.env.MODE !== "sepolia";
const RPC_URL =
  (isLocal ? process.env.PONDER_RPC_URL_31337 : process.env.PONDER_RPC_URL_11155111) ??
  process.env.SEPOLIA_RPC_URL ??
  "http://127.0.0.1:8545";

// The EOA whose decrypt rights the indexer holds. In local mode it defaults to the
// well-known Anvil account #0 — a public, universally-known dev key (never a real
// secret) — so the local stack is zero-config. Zero when unset elsewhere (e.g. codegen)
// so config/import never throws.
const ANVIL_ACCT0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const PRIVATE_KEY = (process.env.PRIVATE_KEY ?? (isLocal ? ANVIL_ACCT0 : "")) as Hex;
export const holderAddress: Address = /^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY)
  ? privateKeyToAccount(PRIVATE_KEY).address
  : ZERO;

// Result of a decrypt attempt. Never throws to the caller — the handler maps it
// onto the row's status:
//   - decrypted: cleartext obtained
//   - pending:   not (yet) entitled — keep the handle, retry when an ACL grant lands
//   - failed:    transient (relayer/network) — retry on the block sweep
export type DecryptOutcome =
  | { status: "decrypted"; value: bigint }
  | { status: "pending"; reason: string }
  | { status: "failed"; reason: string };

let sdkSingleton: ZamaSDK | null = null;

function buildSdk(): ZamaSDK {
  if (!/^0x[0-9a-fA-F]{64}$/.test(PRIVATE_KEY))
    throw new Error("Missing required env: PRIVATE_KEY (the indexer's holder/delegate EOA)");
  const account = privateKeyToAccount(PRIVATE_KEY);
  const transport = http(RPC_URL);
  const viemChain = isLocal ? foundry : viemSepolia;
  const publicClient = createPublicClient({ chain: viemChain, transport });
  const walletClient = createWalletClient({ account, chain: viemChain, transport });

  const fheChain: FheChain = isLocal
    ? {
        // forge-fhevm's canonical local host addresses ARE the SDK `hardhat` preset
        // (ACL 0x50157C…, executor 0xe3a910…), so no address env is needed. Override
        // only if you deployed the host stack at non-standard addresses.
        ...hardhat,
        network: RPC_URL,
        ...(process.env.ACL_ADDRESS && { aclContractAddress: process.env.ACL_ADDRESS as Address }),
        ...(process.env.EXECUTOR_ADDRESS && {
          executorAddress: process.env.EXECUTOR_ADDRESS as Address,
        }),
      }
    : {
        ...sepolia,
        network: RPC_URL,
        ...(process.env.RELAYER_API_KEY && {
          auth: { __type: "ApiKeyHeader" as const, value: process.env.RELAYER_API_KEY },
        }),
      };

  return new ZamaSDK(
    createConfig({
      chains: [fheChain],
      publicClient,
      walletClient,
      storage: new MemoryStorage(),
      relayers: { [fheChain.id]: isLocal ? cleartext() : node() },
    }),
  );
}

function getSdk(): ZamaSDK {
  if (!sdkSingleton) sdkSingleton = buildSdk();
  return sdkSingleton;
}

// Map an SDK decrypt failure onto a persistable status using the SDK's own typed
// error taxonomy, not by scraping messages: every SDK error extends ZamaError
// (with a machine-readable `code`), and relayer HTTP failures carry a numeric
// `statusCode`. "failed" is retried by the block sweep; "pending" is kept and
// retried when an ACL grant lands.
//
// Residual gap (see DECISIONS.md "SDK feedback"): "not entitled to decrypt" has no
// distinct error type — on the relayer path it is a generic 4xx RelayerRequestFailedError,
// on the cleartext path a DecryptionFailedError whose message names the missing auth — so
// the failed-vs-pending policy here is ours to own (and we must sniff the message).
function classify(err: unknown): DecryptOutcome {
  // Grant exists on-chain but hasn't propagated to the gateway yet → retry soon.
  if (err instanceof DelegationNotPropagatedError)
    return { status: "failed", reason: "delegation-not-propagated" };
  // Typed relayer HTTP failure — read the status off the error, no casting.
  if (err instanceof RelayerRequestFailedError) {
    const { statusCode } = err;
    if (statusCode === 429 || (statusCode !== undefined && statusCode >= 500))
      return { status: "failed", reason: `relayer-${statusCode}` };
    return { status: "pending", reason: `relayer-${statusCode ?? "4xx"}` };
  }
  // No ciphertext for this account (never shielded) → wait for entitlement.
  if (err instanceof NoCiphertextError) return { status: "pending", reason: "no-ciphertext" };
  // DecryptionFailedError is overloaded: the cleartext ACL guard also throws it for
  // "not entitled" (message names the missing authorization). Park those as pending so a
  // later ACL grant can backfill them; genuine status-less transport failures stay "failed".
  if (err instanceof DecryptionFailedError) {
    if (/not authorized|not delegated|not allowed/i.test(err.message))
      return { status: "pending", reason: "not-entitled" };
    return { status: "failed", reason: "decrypt-failed" };
  }
  // Errors that bypass the SDK's wrapping (e.g. the artifact-cache key fetch throws
  // a bare Error with the status only in the message) → last-ditch transient sniff.
  const reason = err instanceof Error ? err.message : String(err);
  if (
    /timeout|timed out|econnreset|econnrefused|network|fetch failed|socket hang up|50[234]/i.test(
      reason,
    )
  )
    return { status: "failed", reason: "transient-network" };
  return { status: "pending", reason };
}

async function decryptOne(
  handle: Hex,
  contract: Address,
  delegator?: Address,
): Promise<DecryptOutcome> {
  try {
    const input = [{ encryptedValue: handle, contractAddress: contract }];
    const result = delegator
      ? await getSdk().decryption.delegatedDecryptValues(input, delegator)
      : await getSdk().decryption.decryptValues(input);
    const value = Object.values(result)[0];
    if (value === undefined || value === null)
      return { status: "pending", reason: "no-value-returned" };
    return {
      status: "decrypted",
      value: typeof value === "bigint" ? value : BigInt(value as string),
    };
  } catch (err) {
    return classify(err);
  }
}

/** Decrypt an amount handle the holder is directly entitled to (party to the transfer). */
export function decryptAmount(handle: Hex, contract: Address): Promise<DecryptOutcome> {
  return decryptOne(handle, contract);
}

/** Decrypt an amount handle via an ACL delegation from `delegator` (backfill path). */
export function decryptAmountAs(
  handle: Hex,
  contract: Address,
  delegator: Address,
): Promise<DecryptOutcome> {
  return decryptOne(handle, contract, delegator);
}

export async function terminate(): Promise<void> {
  await sdkSingleton?.terminate();
  sdkSingleton = null;
}
