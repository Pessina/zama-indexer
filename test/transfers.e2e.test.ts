// End-to-end proof of the brief's core requirement — an event in produces correct
// cleartext out of the API — plus a GAP: a single address whose history mixes decrypted
// and undecryptable rows. Drives real ConfidentialTransfers on the local stack, boots the
// actual indexer (which decrypts as it backfills), then asserts the HTTP read API.
import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { TestActor } from "./helpers/actor";
import { ANVIL_KEYS, LOCAL_RPC } from "../src/anvil";
import { startIndexer, type RunningIndexer } from "./setup/indexer";

const DECIMALS = 6n;
const units = (whole: bigint): bigint => whole * 10n ** DECIMALS;
const { cUSDT } = inject("deployments");

const HOLDER = privateKeyToAccount(ANVIL_KEYS.acct0).address; // the indexer's decrypt identity

const alice = new TestActor(ANVIL_KEYS.acct4); // the queried address — never delegates
const bob = new TestActor(ANVIL_KEYS.acct5); // sends alice a leg, then delegates → that leg decrypts
const carol = new TestActor(ANVIL_KEYS.acct6); // delegates FIRST, then sends → that send must decrypt

const aliceAddr = alice.address.toLowerCase();
const bobAddr = bob.address.toLowerCase();
const carolAddr = carol.address.toLowerCase();
// Keyless sink (recipient only — no key, so it can never delegate) → a permanently pending leg.
const SINK = "0x000000000000000000000000000000000000beef";

type Item = {
  kind: string;
  from: string;
  to: string;
  amount: string | null;
  status: string;
};
type Body = {
  items: Item[];
  delegationRequired: boolean;
};

let indexer: RunningIndexer;

beforeAll(async () => {
  // Drive all events BEFORE booting the indexer so it backfills them with no live race.
  // Block order == this order, which is what the indexer replays.
  await bob.mintAndShield(cUSDT, units(60n));
  await bob.confidentialTransfer(cUSDT, alice.address, units(10n)); // bob → alice (will decrypt via bob's grant)
  await alice.mintAndShield(cUSDT, units(100n)); // alice's shield (pending — nobody entitled)
  await alice.confidentialTransfer(cUSDT, SINK, units(7n)); // alice → SINK (pending — sink can't delegate)
  await bob.delegateDecryption(cUSDT, HOLDER); // grant → backfill decrypts rows touching bob (bob → alice)

  // carol delegates BEFORE she sends — the reverse of bob's order. Her shield (pre-grant)
  // is backfilled when the grant is indexed; her send AFTER the grant is the regression:
  // the old decrypt-only handler left it `pending` forever (no event re-fires for an
  // already-active grant), the fix resolves carol's delegation and decrypts it at index time.
  await carol.mintAndShield(cUSDT, units(40n));
  await carol.delegateDecryption(cUSDT, HOLDER);
  await carol.confidentialTransfer(cUSDT, SINK, units(8n)); // carol → SINK, AFTER the grant

  // Settle the blocks behind head so realtime sync indexes them deterministically.
  await fetch(LOCAL_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "anvil_mine", params: ["0x5"], id: 1 }),
  });
  indexer = await startIndexer();
}, 180_000);

afterAll(async () => {
  await indexer?.stop();
  alice.terminate();
  bob.terminate();
  carol.terminate();
});

const get = async (addr: string): Promise<Body> => {
  const res = await fetch(`${indexer.baseUrl}/v1/addresses/${addr}/transfers`);
  expect(res.status).toBe(200);
  return (await res.json()) as Body;
};

describe("GET /v1/addresses/:address/transfers (booted indexer)", () => {
  test("event in → cleartext out: alice's incoming leg from a delegating counterparty is decrypted", async () => {
    const body = await get(aliceAddr);
    const incoming = body.items.find(
      (i) => i.kind === "transfer" && i.from === bobAddr && i.to === aliceAddr,
    );
    expect(incoming).toBeDefined();
    expect(incoming?.status).toBe("decrypted");
    expect(incoming?.amount).toBe(units(10n).toString()); // exact cleartext, via bob's delegation
  });

  test("never dropped, never a wrong number: rows with no entitled party stay pending", async () => {
    const body = await get(aliceAddr);
    // Her send to a keyless sink — no party can delegate for it.
    const out = body.items.find(
      (i) => i.kind === "transfer" && i.from === aliceAddr && i.to === SINK,
    );
    expect(out).toBeDefined();
    expect(out?.amount).toBeNull();
    expect(out?.status).toBe("pending");
    // Her shield is likewise pending (only alice could unlock it, and she never delegated).
    expect(body.items.some((i) => i.kind === "shield" && i.status === "pending")).toBe(true);
  });

  test("gap: alice's history mixes decrypted and pending — delegationRequired flags it, nothing faked", async () => {
    const body = await get(aliceAddr);
    const statuses = new Set(body.items.map((i) => i.status));
    expect(statuses.has("decrypted")).toBe(true); // bob → alice
    expect(statuses.has("pending")).toBe(true); // alice's shield + alice → SINK
    // Alice isn't the holder and has pending rows → a delegation from her would unlock them.
    // The flag is the one action signal; raw per-status counts are intentionally gone.
    expect(body.delegationRequired).toBe(true);
  });

  test("delegationRequired is false for the holder — it decrypts its own rights, no action", async () => {
    const body = await get(HOLDER.toLowerCase());
    expect(body.delegationRequired).toBe(false);
  });

  // Regression (delegate-then-transfer): carol granted the holder rights BEFORE this send,
  // so no `DelegatedForUserDecryption` re-fires for it. The old decrypt-only handler left
  // it `pending` forever; the fix resolves carol's already-active delegation at index time.
  // End-to-end proof: booted indexer → HTTP API shows the post-grant send as cleartext.
  test("delegate-then-transfer: a send made AFTER the grant is decrypted, not stuck pending", async () => {
    const body = await get(carolAddr);
    const out = body.items.find(
      (i) => i.kind === "transfer" && i.from === carolAddr && i.to === SINK,
    );
    expect(out).toBeDefined();
    expect(out?.status).toBe("decrypted");
    expect(out?.amount).toBe(units(8n).toString()); // exact cleartext, via carol's prior grant
  });
});
