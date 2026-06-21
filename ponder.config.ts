import { createConfig } from "ponder";

import { aclEventsAbi } from "./abis/aclEvents";
import { confidentialWrapperAbi } from "./abis/erc7984";
import {
  ACL_ADDRESS,
  ACL_START_BLOCK,
  CHAIN_ID,
  RPC_URL,
  START_BLOCK,
  TOKEN_ADDRESS,
  holderAddress,
} from "./src/config";

// Local-only: Anvil + forge-fhevm, decryption via the SDK's cleartext() transport.
// All env/config is validated once in src/config.ts (the single source of truth).
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
        { event: "DelegatedForUserDecryption", args: { delegate: holderAddress } },
        { event: "RevokedDelegationForUserDecryption", args: { delegate: holderAddress } },
      ],
    },
  },
  // Periodic safety-net to retry transient decrypt failures (status="failed").
  // Event-driven backfill (ACL delegation) is the primary path; this just sweeps
  // up RPC/decrypt hiccups.
  blocks: {
    RetryDecryptions: {
      chain: "fhevm",
      startBlock: START_BLOCK,
      interval: 50,
    },
  },
});
