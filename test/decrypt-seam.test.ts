// Wiring smoke test: proves the local stack is correctly assembled end-to-end —
// anvil + forge-fhevm host stack + the deployed cUSDT token + the SDK `cleartext()`
// transport + on-chain ACL — by driving the indexer's own decrypt seam
// (`src/lib/zama`) the same way the indexer does. Funding happens here in the hook
// (mint → shield, then an ACL delegation), not in a demo script.
//
// The local stack is provisioned automatically by test/setup/global.ts (an ephemeral
// anvil + deploy, or a chain you already have running). The deploy pre-wraps acct0
// (the holder) with 1000 cUSDT; acct1/acct2 start empty.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

import { decryptAmount, decryptAmountAs, terminate as terminateSeam } from "../src/lib/zama";
import { ANVIL_KEYS } from "./helpers/accounts";
import { loadDeployments } from "./helpers/deployments";
import { makeSigner } from "./helpers/local-sdk";
import { delegateDecryption, mintAndShield } from "./helpers/topup";

const DECIMALS = 6n;
const units = (whole: bigint): bigint => whole * 10n ** DECIMALS;

const { cUSDT } = loadDeployments();
const holder = privateKeyToAccount(ANVIL_KEYS.acct0).address; // the indexer's holder
const stranger = privateKeyToAccount(ANVIL_KEYS.acct1).address; // never delegates to holder
const grantor = privateKeyToAccount(ANVIL_KEYS.acct2).address; // delegates to holder

// Read an account's confidential balance handle (a public on-chain read — any signer works).
const reader = makeSigner(ANVIL_KEYS.acct0);
async function balanceHandle(owner: Address): Promise<Hex> {
  return (await reader.sdk.createToken(cUSDT).confidentialBalanceOf(owner)) as Hex;
}

beforeAll(async () => {
  await mintAndShield(ANVIL_KEYS.acct1, { confidentialToken: cUSDT, amount: units(50n) });
  await mintAndShield(ANVIL_KEYS.acct2, { confidentialToken: cUSDT, amount: units(30n) });
  await delegateDecryption(ANVIL_KEYS.acct2, { confidentialToken: cUSDT, delegate: holder });
}, 120_000);

afterAll(async () => {
  await reader.sdk.terminate();
  await terminateSeam();
});

describe("decrypt seam against the local cleartext stack", () => {
  test("holder decrypts a handle it is entitled to (its own balance)", async () => {
    const outcome = await decryptAmount(await balanceHandle(holder), cUSDT);
    expect(outcome).toEqual({ status: "decrypted", value: units(1000n) });
  });

  test("holder cannot decrypt a stranger's handle → pending, never dropped", async () => {
    const outcome = await decryptAmount(await balanceHandle(stranger), cUSDT);
    expect(outcome.status).toBe("pending");
  });

  test("an ACL delegation unlocks decryption (the backfill path)", async () => {
    const outcome = await decryptAmountAs(await balanceHandle(grantor), cUSDT, grantor);
    expect(outcome).toEqual({ status: "decrypted", value: units(30n) });
  });
});
