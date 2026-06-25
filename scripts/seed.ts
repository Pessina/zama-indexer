// Manual-test seed: drives real on-chain activity so you can poke the running
// indexer by hand (curl the balance endpoint), not just via the e2e suite. It sets
// up every state worth seeing: balances that are complete / indeterminate, and
// transfer rows that are decrypted / pending / backfilled-after-delegation.
//
// Prereqs (separate terminals): `pnpm chain`, `pnpm local:deploy`, `pnpm dev`.
// Then run this against the same chain:  pnpm dlx tsx scripts/seed.ts
// Re-run it any time to append more activity; reset by restarting the stack.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Address } from "viem";

import { ZamaClient } from "../src/utils/zama";
import { ANVIL_KEYS, LOCAL_RPC } from "../src/anvil";

const DECIMALS = 6n;
const units = (whole: bigint): bigint => whole * 10n ** DECIMALS;

const { cUSDT } = JSON.parse(readFileSync(resolve("contracts", "deployments.json"), "utf8")) as {
  cUSDT: Address;
};

// The open `mint` on the wrapper's underlying ERC-20 (test tokens only).
const MINT_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const holder = new ZamaClient({ privateKey: ANVIL_KEYS.acct0, rpc: LOCAL_RPC });
const alice = new ZamaClient({ privateKey: ANVIL_KEYS.acct1, rpc: LOCAL_RPC });
const bob = new ZamaClient({ privateKey: ANVIL_KEYS.acct2, rpc: LOCAL_RPC });

async function mintAndShield(c: ZamaClient, amount: bigint): Promise<void> {
  const wrapped = c.sdk.createWrappedToken(cUSDT);
  const underlying = await wrapped.underlying();
  const hash = await c.walletClient.writeContract({
    address: underlying,
    abi: MINT_ABI,
    functionName: "mint",
    args: [c.account.address, amount],
  });
  await c.publicClient.waitForTransactionReceipt({ hash });
  await wrapped.shield(amount); // approve + wrap, to self
}

async function main(): Promise<void> {
  console.log("token :", cUSDT);
  console.log("holder:", holder.account.address);
  console.log("alice :", alice.account.address);
  console.log("bob   :", bob.account.address, "\n");

  // 1) alice shields 50 → a ConfidentialTransfer mint to alice the holder is not a
  //    party to → row lands `pending` (handle stored, never dropped).
  await mintAndShield(alice, units(50n));
  console.log("alice shielded 50  → expect a PENDING transfer row");

  // 2) holder sends 10 to alice → holder is a party → row lands `decrypted`.
  await holder.sdk.createToken(cUSDT).confidentialTransfer(alice.account.address, units(10n));
  console.log("holder → alice 10  → expect a DECRYPTED transfer row");

  // 3) bob shields 30 but never delegates → his /balance is `indeterminate`
  //    (and his mint stays a PENDING transfer row — entitlement never arrives).
  await mintAndShield(bob, units(30n));
  console.log("bob shielded 30    → bob's /balance is INDETERMINATE");

  // 4) alice grants decrypt rights to the holder → the ACL handler backfills alice's
  //    pending rows (the 50 mint flips PENDING → DECRYPTED), and her /balance becomes
  //    `complete` via the delegated path.
  await alice.sdk.delegations.delegateDecryption({
    contractAddress: cUSDT,
    delegateAddress: holder.account.address,
  });
  console.log("alice delegated    → her PENDING 50 backfills; her /balance is COMPLETE");

  holder.terminate();
  alice.terminate();
  bob.terminate();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
