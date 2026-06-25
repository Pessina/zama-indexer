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
] as const;
