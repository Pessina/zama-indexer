import { createConfig } from "ponder";
import { privateKeyToAccount } from "viem/accounts";

import { aclEventsAbi } from "./abis/aclEvents";
import { confidentialWrapperAbi } from "./abis/erc7984";

// ── Chain selection ───────────────────────────────────────────────────────────
// MODE=local  → Anvil + forge-fhevm, decryption via the SDK's cleartext() transport
// MODE=sepolia→ Sepolia, real FHE via the hosted relayer (node() transport)
// The indexer code is identical; only env + the decrypt transport differ.
// Default to local-first (Anvil + forge-fhevm + cleartext); set MODE=sepolia for the live relayer path.
const isLocal = process.env.MODE !== "sepolia";
const CHAIN_ID = isLocal ? 31337 : 11155111;
const RPC_URL =
  (isLocal ? process.env.PONDER_RPC_URL_31337 : process.env.PONDER_RPC_URL_11155111) ??
  "http://127.0.0.1:8545";

const ZERO = "0x0000000000000000000000000000000000000000" as const;
const asAddress = (v: string | undefined) => (v ?? ZERO) as `0x${string}`;

// The ERC-7984 confidential wrapper to index (resolve from an ERC-20 via the
// SDK registry once, then pin it here). ACL is the protocol's access-control
// contract (from the chain preset on Sepolia, or your local deployment).
const TOKEN_ADDRESS = asAddress(process.env.CONFIDENTIAL_TOKEN_ADDRESS);
// The protocol ACL contract (source of delegation events). Defaults to the canonical
// address for the selected chain — forge-fhevm's local ACL, or the SDK's Sepolia preset —
// so it's zero-config; override via env only for a non-standard deployment.
const LOCAL_ACL = "0x50157CFfD6bBFA2DECe204a89ec419c23ef5755D";
const SEPOLIA_ACL = "0xf0Ffdc93b7E186bC2f8CB3dAA75D86d1930A433D";
const ACL_ADDRESS = asAddress(process.env.ACL_ADDRESS ?? (isLocal ? LOCAL_ACL : SEPOLIA_ACL));
const START_BLOCK = Number(process.env.START_BLOCK ?? 0);
const ACL_START_BLOCK = Number(process.env.ACL_START_BLOCK ?? START_BLOCK);

// The indexer's holder identity — the EOA whose decrypt rights we hold. Derived
// from PRIVATE_KEY so it can never drift from the seam's signer. Falls back to
// the zero address when no key is set (e.g. `pnpm codegen` with no .env.local),
// which simply matches no delegations.
// Well-known Anvil account #0 (public dev key) — the default holder in local mode.
const ANVIL_ACCT0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
function holderAddress(): `0x${string}` {
  const pk = process.env.PRIVATE_KEY ?? (isLocal ? ANVIL_ACCT0 : undefined);
  return pk && /^0x[0-9a-fA-F]{64}$/.test(pk)
    ? privateKeyToAccount(pk as `0x${string}`).address
    : ZERO;
}
const HOLDER = holderAddress();

export default createConfig({
  chains: {
    fhevm: { id: CHAIN_ID, rpc: RPC_URL },
  },
  contracts: {
    ConfidentialToken: {
      chain: "fhevm",
      abi: confidentialWrapperAbi,
      address: TOKEN_ADDRESS,
      startBlock: START_BLOCK,
    },
    Acl: {
      chain: "fhevm",
      abi: aclEventsAbi,
      address: ACL_ADDRESS,
      startBlock: ACL_START_BLOCK,
      // Scope the shared ACL contract's firehose to delegations granted TO our
      // holder — those are the only ones that can unlock backfill for us.
      filter: [
        { event: "DelegatedForUserDecryption", args: { delegate: HOLDER } },
        { event: "RevokedDelegationForUserDecryption", args: { delegate: HOLDER } },
      ],
    },
  },
  // Periodic safety-net to retry transient decrypt failures (status="failed").
  // Event-driven backfill (ACL delegation) is the primary path; this just sweeps
  // up relayer hiccups. Kept infrequent to avoid hammering the relayer.
  blocks: {
    RetryDecryptions: {
      chain: "fhevm",
      startBlock: START_BLOCK,
      interval: isLocal ? 50 : 30,
    },
  },
});
