// ACL delegation events.
//
// The vendored `acl.ts` (copied from the SDK) contains only the ACL *functions*.
// Ponder needs the *event* ABI to index delegation grants/revokes — these are the
// on-chain trigger for backfilling cleartext once a partner grants the indexer
// decryption rights. Signatures are the canonical ones from the SDK's decoder
// source (`sdk/packages/sdk/src/events/onchain-events.ts`, `AclTopics`).
//
// `delegator` and `delegate` are indexed, so Ponder can filter to only the
// delegations granted *to our holder* (see ponder.config.ts).
export const aclEventsAbi = [
  {
    type: "event",
    name: "DelegatedForUserDecryption",
    anonymous: false,
    inputs: [
      { name: "delegator", type: "address", indexed: true, internalType: "address" },
      { name: "delegate", type: "address", indexed: true, internalType: "address" },
      { name: "contractAddress", type: "address", indexed: false, internalType: "address" },
      { name: "delegationCounter", type: "uint64", indexed: false, internalType: "uint64" },
      { name: "oldExpirationDate", type: "uint64", indexed: false, internalType: "uint64" },
      { name: "newExpirationDate", type: "uint64", indexed: false, internalType: "uint64" },
    ],
  },
  {
    type: "event",
    name: "RevokedDelegationForUserDecryption",
    anonymous: false,
    inputs: [
      { name: "delegator", type: "address", indexed: true, internalType: "address" },
      { name: "delegate", type: "address", indexed: true, internalType: "address" },
      { name: "contractAddress", type: "address", indexed: false, internalType: "address" },
      { name: "delegationCounter", type: "uint64", indexed: false, internalType: "uint64" },
      { name: "oldExpirationDate", type: "uint64", indexed: false, internalType: "uint64" },
    ],
  },
] as const;
