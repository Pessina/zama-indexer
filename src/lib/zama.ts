// The decrypt seam — the ONLY module that touches @zama-fhe/sdk.
//
// Builds one process-wide ZamaSDK over the SDK's cleartext() transport (Anvil +
// forge-fhevm: reads the on-chain mock executor, enforces real ACL — no hosted
// relayer) and turns an encrypted amount handle into either cleartext or a status
// the indexer can persist. Tests mock this module, so they never construct a real SDK.
import { createPublicClient, createWalletClient, http } from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { DecryptionFailedError, MemoryStorage, ZamaSDK } from "@zama-fhe/sdk";
import { hardhat, type FheChain } from "@zama-fhe/sdk/chains";
import { createConfig } from "@zama-fhe/sdk/viem";
import { cleartext } from "@zama-fhe/sdk/node";

import { ACL_ADDRESS, EXECUTOR_ADDRESS, PRIVATE_KEY, RPC_URL } from "../config";

// Result of a decrypt attempt. Never throws to the caller — the handler maps it
// onto the row's status:
//   - decrypted: cleartext obtained
//   - pending:   not (yet) entitled — keep the handle, retry when an ACL grant lands
//   - failed:    transient (decrypt / RPC) — retry on the block sweep
export type DecryptOutcome =
  | { status: "decrypted"; value: bigint }
  | { status: "pending"; reason: string }
  | { status: "failed"; reason: string };

let sdkSingleton: ZamaSDK | null = null;

function buildSdk(): ZamaSDK {
  const account = privateKeyToAccount(PRIVATE_KEY);
  const transport = http(RPC_URL);
  const publicClient = createPublicClient({ chain: foundry, transport });
  const walletClient = createWalletClient({ account, chain: foundry, transport });

  // forge-fhevm's canonical host addresses ARE the SDK `hardhat` preset. We pin the
  // ACL from config so the cleartext transport and the indexer's delegation filter
  // share one source of truth; the executor is overridden only if explicitly set.
  const fheChain: FheChain = {
    ...hardhat,
    network: RPC_URL,
    aclContractAddress: ACL_ADDRESS,
    ...(EXECUTOR_ADDRESS && { executorAddress: EXECUTOR_ADDRESS }),
  };

  return new ZamaSDK(
    createConfig({
      chains: [fheChain],
      publicClient,
      walletClient,
      storage: new MemoryStorage(),
      relayers: { [fheChain.id]: cleartext() },
    }),
  );
}

function getSdk(): ZamaSDK {
  if (!sdkSingleton) sdkSingleton = buildSdk();
  return sdkSingleton;
}

// Map an SDK decrypt failure onto a persistable status. On the cleartext transport
// the ACL guard throws DecryptionFailedError for "not entitled" (the message names
// the missing authorization) — the SDK has no distinct type/code for it, so we sniff
// the message (see DECISIONS.md "SDK feedback"). "failed" is retried by the block
// sweep; "pending" is kept and retried when an ACL grant lands.
function classify(err: unknown): DecryptOutcome {
  if (err instanceof DecryptionFailedError) {
    // Not entitled / no ACL delegation → park as pending for grant-driven backfill.
    if (/not authorized|not delegated|not allowed/i.test(err.message))
      return { status: "pending", reason: "not-entitled" };
    // Any other decrypt failure (e.g. a genuine SDK decrypt error) → transient.
    return { status: "failed", reason: "decrypt-failed" };
  }
  // Raw transport/RPC errors (e.g. Anvil unreachable) → retry on the sweep.
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
