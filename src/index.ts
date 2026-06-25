import { ponder } from "ponder:registry";
import schema from "ponder:schema";
import { and, eq, lt, or } from "ponder";
import type { Hex } from "viem";

import { zama } from "./zama-client";
import { config } from "./config";

const TOKEN = config.tokenAddress;
const MAX_ATTEMPTS = 5; // stop retrying a "failed" row after this many sweeps
const RETRY_BATCH = 25; // cap decrypts per block-sweep

const isZero = (a: string): boolean => /^0x0+$/i.test(a);

// Confidential transfers — the single activity ledger. Shields (from==0x0 → mint) and
// unshields (to==0x0 → burn) land here too. Store the handle always, fill cleartext if
// we hold the rights, else persist a status (pending/failed) — never drop the row.
ponder.on("ConfidentialToken:ConfidentialTransfer", async ({ event, context }) => {
  const from = event.args.from.toLowerCase() as Hex;
  const to = event.args.to.toLowerCase() as Hex;
  const handle = event.args.amount as Hex;
  const outcome = await zama.decryptTransfer(handle, TOKEN, [from, to]);

  await context.db
    .insert(schema.transfer)
    .values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      fromAddress: from,
      toAddress: to,
      kind: isZero(from) ? "mint" : isZero(to) ? "burn" : "transfer",
      amountHandle: handle,
      amountClear: outcome.status === "decrypted" ? outcome.value : null,
      status: outcome.status,
      decryptAttempts: 1,
      blockNumber: event.block.number,
      logIndex: event.log.logIndex,
      timestamp: event.block.timestamp,
    })
    .onConflictDoNothing();
});

// ACL delegation granted to our holder (config filters to delegate == holder): backfill
// the delegator's pending transfers via delegated decrypt. No delegation row is persisted —
// the grant event carries the delegator, which is all the backfill needs.
ponder.on("Acl:DelegatedForUserDecryption", async ({ event, context }) => {
  const delegator = event.args.delegator.toLowerCase() as Hex;

  const pending = await context.db.sql
    .select()
    .from(schema.transfer)
    .where(
      and(
        eq(schema.transfer.status, "pending"),
        or(eq(schema.transfer.fromAddress, delegator), eq(schema.transfer.toAddress, delegator)),
      ),
    );

  for (const row of pending) {
    const outcome = await zama.decrypt(row.amountHandle, TOKEN, delegator);
    if (outcome.status !== "decrypted") continue;
    await context.db.update(schema.transfer, { id: row.id }).set({
      amountClear: outcome.value,
      status: "decrypted",
      decryptAttempts: row.decryptAttempts + 1,
    });
  }
});

// Safety-net for transient "failed" decryptions (bounded), retried on the direct path.
// Entitlement backfill is event-driven above; this just sweeps RPC/decrypt hiccups.
ponder.on("RetryDecryptions:block", async ({ context }) => {
  const failed = await context.db.sql
    .select()
    .from(schema.transfer)
    .where(
      and(eq(schema.transfer.status, "failed"), lt(schema.transfer.decryptAttempts, MAX_ATTEMPTS)),
    )
    .limit(RETRY_BATCH);

  for (const row of failed) {
    const outcome = await zama.decrypt(row.amountHandle, TOKEN);
    await context.db.update(schema.transfer, { id: row.id }).set(
      outcome.status === "decrypted"
        ? {
            amountClear: outcome.value,
            status: "decrypted",
            decryptAttempts: row.decryptAttempts + 1,
          }
        : { status: outcome.status, decryptAttempts: row.decryptAttempts + 1 },
    );
  }
});
