import { createConfig } from "ponder";

import { aclEventsAbi } from "./abis/aclEvents";
import { confidentialWrapperAbi } from "./abis/erc7984";
import { config } from "./src/config";

// Local-only: Anvil + forge-fhevm, decryption via the SDK's cleartext() transport.
// All env/config is validated once in src/config.ts (the single source of truth).
export default createConfig({
  chains: {
    fhevm: { id: config.chainId, rpc: config.rpcUrl },
  },
  contracts: {
    ConfidentialToken: {
      chain: "fhevm",
      abi: confidentialWrapperAbi,
      address: config.tokenAddress,
      startBlock: config.startBlock,
    },
    Acl: {
      chain: "fhevm",
      abi: aclEventsAbi,
      address: config.aclAddress,
      startBlock: config.aclStartBlock,
      // Scope the shared ACL contract's firehose to delegations granted TO our
      // holder — those are the only ones that can unlock backfill for us.
      filter: [
        { event: "DelegatedForUserDecryption", args: { delegate: config.holderAddress } },
        { event: "RevokedDelegationForUserDecryption", args: { delegate: config.holderAddress } },
      ],
    },
  },
  // Periodic safety-net to retry transient decrypt failures (status="failed").
  // Event-driven backfill (ACL delegation) is the primary path; this just sweeps
  // up RPC/decrypt hiccups.
  blocks: {
    RetryDecryptions: {
      chain: "fhevm",
      startBlock: config.startBlock,
      interval: 50,
    },
  },
});
