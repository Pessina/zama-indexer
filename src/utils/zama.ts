import { createPublicClient, createWalletClient, http } from "viem";
import type { Address, Hex, HttpTransport, PublicClient, WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { matchZamaError, MemoryStorage, ZamaSDK } from "@zama-fhe/sdk";
import { hardhat, type FheChain } from "@zama-fhe/sdk/chains";
import { createConfig } from "@zama-fhe/sdk/viem";
import { cleartext } from "@zama-fhe/sdk/node";

// decrypted: cleartext obtained · pending: not (yet) entitled, retry on an ACL grant
// · failed: transient (decrypt/RPC), retry on the block sweep.
export type DecryptOutcome =
  | { status: "decrypted"; value: bigint }
  | { status: "pending"; reason: string }
  | { status: "failed"; reason: string };

export interface ZamaClientOptions {
  privateKey: Hex;
  rpc: string;
}

export class ZamaClient {
  readonly account: PrivateKeyAccount;
  readonly publicClient: PublicClient<HttpTransport, typeof foundry>;
  readonly walletClient: WalletClient<HttpTransport, typeof foundry, PrivateKeyAccount>;
  readonly sdk: ZamaSDK;

  constructor(opts: ZamaClientOptions) {
    this.account = privateKeyToAccount(opts.privateKey);
    const transport = http(opts.rpc);
    this.publicClient = createPublicClient({ chain: foundry, transport });
    this.walletClient = createWalletClient({ account: this.account, chain: foundry, transport });

    const fheChain: FheChain = { ...hardhat, network: opts.rpc };

    this.sdk = new ZamaSDK(
      createConfig({
        chains: [fheChain],
        publicClient: this.publicClient,
        walletClient: this.walletClient,
        storage: new MemoryStorage(),
        relayers: { [fheChain.id]: cleartext() },
      }),
    );
  }

  // Decrypt an amount handle. With `delegator`, decrypt via that account's ACL
  // delegation (the backfill path); without it, as a direct party to the transfer.
  async decrypt(handle: Hex, contract: Address, delegator?: Address): Promise<DecryptOutcome> {
    try {
      const input = [{ encryptedValue: handle, contractAddress: contract }];
      const result = delegator
        ? await this.sdk.decryption.delegatedDecryptValues(input, delegator)
        : await this.sdk.decryption.decryptValues(input);
      const value = Object.values(result)[0];
      if (value === undefined || value === null)
        return { status: "pending", reason: "no-value-returned" };
      return {
        status: "decrypted",
        value: typeof value === "bigint" ? value : BigInt(value as string),
      };
    } catch (err) {
      return classifyDecryptError(err);
    }
  }

  // Read an account's confidential balance handle and decrypt it. An uninitialised
  // balance (never received tokens) is an all-zero handle on-chain — short-circuit to
  // 0 rather than decrypt a non-ciphertext.
  async readBalance(token: Address, owner: Address, delegator?: Address): Promise<DecryptOutcome> {
    const handle = (await this.sdk.createToken(token).confidentialBalanceOf(owner)) as Hex;
    if (/^0x0+$/i.test(handle)) return { status: "decrypted", value: 0n };
    return this.decrypt(handle, token, delegator);
  }

  // Decrypt a transfer amount the best way the holder is entitled to: directly when the
  // holder is a party, else via a party (from/to) that CURRENTLY delegates decryption to
  // the holder. Entitlement is evaluated as a LEVEL at index time, so a transfer that
  // arrives while a delegation is already active decrypts immediately — the grant-event
  // backfill (src/index.ts) only covers the reverse order (transfer first, grant later).
  // Probes on-chain isActive before a delegated decrypt (no wasted attempt for a party that
  // never delegated), and returns the direct outcome when no party is entitled, so the row
  // still persists (pending/failed) and retries exactly as before.
  async decryptTransfer(
    handle: Hex,
    token: Address,
    parties: readonly Hex[],
  ): Promise<DecryptOutcome> {
    const direct = await this.decrypt(handle, token);
    if (direct.status !== "pending") return direct; // decrypted, or a transient "failed" to sweep
    const holder = this.account.address.toLowerCase();
    for (const party of parties) {
      if (/^0x0+$/i.test(party) || party.toLowerCase() === holder) continue;
      const entitled = await this.sdk.delegations.isActive({
        contractAddress: token,
        delegatorAddress: party as Address,
        delegateAddress: this.account.address,
      });
      if (!entitled) continue;
      const viaDelegation = await this.decrypt(handle, token, party as Address);
      if (viaDelegation.status === "decrypted") return viaDelegation;
    }
    return direct; // not entitled via any party → pending (awaits a future grant)
  }

  terminate(): void {
    this.sdk.terminate(); // synchronous — shuts down the worker pool
  }
}

// Map an SDK failure onto a persistable status by routing on the SDK's machine-readable
// `ZamaError.code` (via its own `matchZamaError` dispatcher), not message cascades. Fatal
// misconfig codes rethrow; "failed" is retried by the block sweep, "pending" when an ACL
// grant lands. Pure + exported — unit-tested in test/unit/classify.test.ts.
export function classifyDecryptError(err: unknown): DecryptOutcome {
  const outcome = matchZamaError<DecryptOutcome>(err, {
    // Fatal, process-level — fail loud rather than persist a bogus status.
    CHAIN_MISMATCH: (e) => {
      throw e;
    },
    SIGNER_NOT_CONFIGURED: (e) => {
      throw e;
    },
    CONFIGURATION: (e) => {
      throw e;
    },

    // The one decrypt outcome the cleartext transport gives no distinct code for: ACL
    // denial surfaces as a generic DECRYPTION_FAILED, separable only by message — "not
    // authorized" (direct) / "not delegated" (per-handle). → pending (not entitled); any
    // other DECRYPTION_FAILED is a real failure the sweep retries. The string coupling is
    // contained: the SDK is pinned exactly (3.1.0-alpha.15) and a reword fails the
    // "stranger → pending" integration test. See DECISIONS.md "SDK feedback".
    DECRYPTION_FAILED: (e) =>
      /not authorized|not delegated/i.test(e.message)
        ? { status: "pending", reason: "not-entitled" }
        : { status: "failed", reason: "decrypt-failed" },

    // Delegated (backfill) path with no active delegation — the SDK's typed pre-flight
    // codes (no string coupling). "Not entitled" → pending: retry when a (re-)grant lands.
    DELEGATION_NOT_FOUND: () => ({ status: "pending", reason: "delegation-not-found" }),
    DELEGATION_EXPIRED: () => ({ status: "pending", reason: "delegation-expired" }),

    // Relayer-transport conditions (don't fire on cleartext; mapped for when a relayer
    // path is added). Self-resolving → retry as "failed" on the time-based sweep.
    DELEGATION_NOT_PROPAGATED: () => ({ status: "failed", reason: "delegation-not-propagated" }),
    RELAYER_REQUEST_FAILED: () => ({ status: "failed", reason: "relayer-request-failed" }),
    NO_CIPHERTEXT: () => ({ status: "failed", reason: "no-ciphertext" }),

    // Everything else (raw RPC/transport errors, unmapped codes): default to "failed", never
    // a silent "pending" — a pending row only retries on a grant, so an unknown error parked
    // there would strand forever. The token set mirrors the SDK's internal isTransientError
    // (which substring-matches the same conditions).
    _: (e) => {
      const reason = e instanceof Error ? e.message : String(e);
      return /timeout|timed out|econnreset|econnrefused|network|fetch failed|socket hang up|50[234]/i.test(
        reason,
      )
        ? { status: "failed", reason: "transient-network" }
        : { status: "failed", reason };
    },
  });
  return outcome ?? { status: "failed", reason: "unclassified" };
}
