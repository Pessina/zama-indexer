// Wiring smoke test: proves the local stack is correctly assembled end-to-end —
// anvil + forge-fhevm host stack + the deployed cUSDT token + the SDK `cleartext()`
// transport + on-chain ACL — by driving the indexer's decrypt seam the same way the
// indexer does, through a TestActor per account. Funding happens here in the hook
// (mint → shield, then an ACL delegation), not in a demo script.
//
// The local stack is provisioned automatically by test/setup/global.ts (an ephemeral
// anvil + deploy, or a chain you already have running), which also hands the deploy
// output to the suite via inject(). The deploy pre-wraps acct0 (the holder) with
// 1000 cUSDT; acct1/acct2 start empty.
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";

import { TestActor } from "./helpers/actor";
import { ANVIL_KEYS } from "../src/anvil";

const DECIMALS = 6n;
const units = (whole: bigint): bigint => whole * 10n ** DECIMALS;

// The single token the indexer watches — provided by test/setup/global.ts after the
// local deploy (vitest provide/inject).
const { cUSDT } = inject("deployments");

const holder = new TestActor(ANVIL_KEYS.acct0); // the indexer's holder (reads + decrypts)
const stranger = new TestActor(ANVIL_KEYS.acct1); // never delegates to holder
const grantor = new TestActor(ANVIL_KEYS.acct2); // delegates to holder

beforeAll(async () => {
  await stranger.mintAndShield(cUSDT, units(50n));
  await grantor.mintAndShield(cUSDT, units(30n));
  await grantor.delegateDecryption(cUSDT, holder.address);
}, 120_000);

afterAll(() => {
  holder.terminate();
  stranger.terminate();
  grantor.terminate();
});

describe("decrypt seam against the local cleartext stack", () => {
  test("holder decrypts a handle it is entitled to (its own balance)", async () => {
    const outcome = await holder.decrypt(await holder.balanceHandle(cUSDT, holder.address), cUSDT);
    expect(outcome).toEqual({ status: "decrypted", value: units(1000n) });
  });

  test("holder cannot decrypt a stranger's handle → pending, never dropped", async () => {
    const outcome = await holder.decrypt(
      await holder.balanceHandle(cUSDT, stranger.address),
      cUSDT,
    );
    expect(outcome.status).toBe("pending");
  });

  // Companion to the stranger case above. That one drives the real "not authorized" throw
  // (#assertDecryptAuthorization, direct path). This one drives the delegated (backfill)
  // path's real pre-flight: with no grant in place the SDK throws the typed
  // DelegationNotFoundError, which classify must map to pending, not failed. (This case
  // caught exactly that bug — and the unit suite alone couldn't, since it can't reproduce
  // the SDK's real delegation pre-flight.)
  test("holder cannot delegate-decrypt a handle with no delegation in place → pending", async () => {
    const outcome = await holder.decrypt(
      await holder.balanceHandle(cUSDT, stranger.address),
      cUSDT,
      stranger.address, // stranger never delegated to holder → real "not delegated" throw
    );
    expect(outcome.status).toBe("pending");
  });

  test("an ACL delegation unlocks decryption (the backfill path)", async () => {
    const outcome = await holder.decrypt(
      await holder.balanceHandle(cUSDT, grantor.address),
      cUSDT,
      grantor.address,
    );
    expect(outcome).toEqual({ status: "decrypted", value: units(30n) });
  });
});
