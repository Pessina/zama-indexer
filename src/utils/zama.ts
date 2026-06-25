// ZamaClient — the ONLY module that imports @zama-fhe/sdk.
//
// Wraps one signer's ZamaSDK over the SDK's cleartext() transport (Anvil +
// forge-fhevm: reads the on-chain mock executor, enforces real ACL — no hosted
// relayer). Production builds a single holder-bound instance (see src/index.ts);
// tests build one per signer (holder, stranger, grantor). `decrypt()` turns an
// encrypted amount handle into either cleartext or a status the indexer can
// persist; it never throws for a decrypt condition (entitlement/transport) and
// rethrows only a fatal misconfiguration (wrong chain, missing signer).
import { createPublicClient, createWalletClient, http } from "viem";
import type { Address, Hex, HttpTransport, PublicClient, WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { matchZamaError, MemoryStorage, ZamaSDK } from "@zama-fhe/sdk";
import { hardhat, type FheChain } from "@zama-fhe/sdk/chains";
import { createConfig } from "@zama-fhe/sdk/viem";
import { cleartext } from "@zama-fhe/sdk/node";

// Result of a decrypt attempt — the handler maps this onto the row's status.
// Covers decrypt conditions only; a fatal misconfiguration is rethrown, not returned:
//   - decrypted: cleartext obtained
//   - pending:   not (yet) entitled — keep the handle, retry when an ACL grant lands
//   - failed:    transient (decrypt / RPC) — retry on the block sweep
export type DecryptOutcome =
  | { status: "decrypted"; value: bigint }
  | { status: "pending"; reason: string }
  | { status: "failed"; reason: string };

export interface ZamaClientOptions {
  privateKey: Hex;
  rpc: string;
  // ACL / executor default to the SDK `hardhat` preset (forge-fhevm's canonical
  // local addresses). Production pins them from config so config stays the single
  // source of truth; tests omit them and take the preset.
  acl?: Address;
  executor?: Address;
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

    // forge-fhevm's canonical host addresses ARE the SDK `hardhat` preset; pin the
    // ACL/executor only when explicitly provided so config can stay the source of truth.
    const fheChain: FheChain = {
      ...hardhat,
      network: opts.rpc,
      ...(opts.acl && { aclContractAddress: opts.acl }),
      ...(opts.executor && { executorAddress: opts.executor }),
    };

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
  // delegation (the backfill path); without it, decrypt as a direct party to the
  // transfer. Decrypt conditions return a pending/failed outcome; only a fatal
  // misconfiguration (see `classifyDecryptError`) is rethrown.
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

  // SDK terminate() is synchronous (returns void) — shuts down the worker pool.
  terminate(): void {
    this.sdk.terminate();
  }
}

// Map an SDK failure onto a persistable status by routing on the SDK's
// machine-readable `ZamaError.code` (via its own `matchZamaError` dispatcher),
// not instanceof + message cascades. Fatal misconfiguration codes RETHROW: a
// wrong chain or missing signer can't be fixed by a retry or an ACL grant, so
// surface it loudly instead of mis-parking every row. "failed" is retried by the
// block sweep; "pending" is retried when an ACL grant lands. Exported (not a
// method) because it is pure — unit-tested directly in test/unit/classify.test.ts.
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

    // Not (yet) entitled. The cleartext transport has NO distinct code for ACL
    // denial — it surfaces as a generic DECRYPTION_FAILED whose only signal is the
    // message. Match the cleartext ACL strings: "not authorized" (#assertDecryptAuthorization,
    // direct path) and "not delegated" (#assertDelegation, a per-handle fallback; the common
    // delegated case is the typed DELEGATION_NOT_FOUND code below). publicDecrypt's "not
    // allowed" is intentionally excluded — the indexer never calls it. Any other
    // DECRYPTION_FAILED is a genuine failure the sweep should retry.
    //
    // False-positive/negative are bounded and never silently dropped: a wrong
    // "pending" still retries when a grant lands; a wrong "failed" still retries on
    // the sweep. And the coupling is contained two ways: `@zama-fhe/sdk` is pinned exactly
    // (3.1.0-alpha.15), so these internal strings can't drift under us without a deliberate
    // bump; and a bump that reworded them fails the "stranger → pending" integration test,
    // which exercises the real SDK throw — so a break surfaces in CI, never silently.
    DECRYPTION_FAILED: (e) =>
      /not authorized|not delegated/i.test(e.message)
        ? { status: "pending", reason: "not-entitled" }
        : { status: "failed", reason: "decrypt-failed" },

    // Not (yet) entitled via the delegated (backfill) path. The SDK's service-level
    // pre-flight throws these TYPED codes (no string coupling) when no active delegation
    // covers the contract — the common backfill case. Like the direct "not authorized"
    // case it is "not entitled", so → pending: keep the row, retry when a
    // DelegatedForUserDecryption (re-)grant lands.
    DELEGATION_NOT_FOUND: () => ({ status: "pending", reason: "delegation-not-found" }),
    DELEGATION_EXPIRED: () => ({ status: "pending", reason: "delegation-expired" }),

    // Relayer-transport conditions (don't fire on cleartext; mapped so the seam is
    // correct when a relayer path is added). Self-resolving → retry as "failed". A
    // propagation delay means the grant ALREADY landed, so it must be retried by the
    // time-based sweep, not by waiting for another (already-fired) grant event.
    DELEGATION_NOT_PROPAGATED: () => ({ status: "failed", reason: "delegation-not-propagated" }),
    RELAYER_REQUEST_FAILED: () => ({ status: "failed", reason: "relayer-request-failed" }),
    NO_CIPHERTEXT: () => ({ status: "failed", reason: "no-ciphertext" }),

    // Everything else: raw RPC/transport errors (not ZamaErrors) and any unmapped
    // code. Default is "failed" (the sweep retries it), NEVER a silent "pending" — a
    // pending row only retries on a grant, so an unknown error parked there would
    // strand forever. The regex mirrors the SDK's internal, non-exported
    // `isTransientError` (relayer-utils.ts) — see DECISIONS.md "SDK feedback".
    _: (e) => {
      const reason = e instanceof Error ? e.message : String(e);
      return /timeout|timed out|econnreset|econnrefused|network|fetch failed|socket hang up|50[234]/i.test(
        reason,
      )
        ? { status: "failed", reason: "transient-network" }
        : { status: "failed", reason };
    },
  });
  // `_` always returns, so `outcome` is never undefined; the fallback only
  // satisfies matchZamaError's `R | undefined` signature.
  return outcome ?? { status: "failed", reason: "unclassified" };
}
