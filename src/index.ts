import { ponder } from "ponder:registry";
import schema from "ponder:schema";
import { and, eq, lt, or } from "ponder";
import type { Hex } from "viem";

import { decryptAmount, decryptAmountAs } from "./lib/zama";
// The single confidential token this indexer watches (its ACL owns the handles).
import { TOKEN_ADDRESS as TOKEN } from "./config";
const MAX_ATTEMPTS = 5; // give up retrying a "failed" row after this many sweeps
const RETRY_BATCH = 25; // bound the relayer load per block-sweep

const lc = (a: string): Hex => a.toLowerCase() as Hex;
const isZero = (a: string): boolean => /^0x0+$/i.test(a);

// ── Confidential transfers — the balance + history spine ──────────────────────
// Best-effort inline decryption: store the handle always; fill cleartext if we
// hold the rights, else persist a status (pending / failed) — never drop the row.
ponder.on("ConfidentialToken:ConfidentialTransfer", async ({ event, context }) => {
  const from = lc(event.args.from);
  const to = lc(event.args.to);
  const handle = event.args.amount as Hex;
  const outcome = await decryptAmount(handle, TOKEN);

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
      txHash: event.transaction.hash,
      logIndex: event.log.logIndex,
      timestamp: event.block.timestamp,
      decryptedAt: outcome.status === "decrypted" ? event.block.timestamp : null,
    })
    .onConflictDoNothing();
});

// ── Shield (wrap) — public amount in ──────────────────────────────────────────
ponder.on("ConfidentialToken:Wrap", async ({ event, context }) => {
  await context.db
    .insert(schema.shieldActivity)
    .values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      kind: "shield",
      account: lc(event.args.to),
      amount: event.args.roundedAmount,
      blockNumber: event.block.number,
      txHash: event.transaction.hash,
      timestamp: event.block.timestamp,
    })
    .onConflictDoNothing();
});

// ── Unshield (unwrap finalize) — public amount out ────────────────────────────
ponder.on("ConfidentialToken:UnwrapFinalized", async ({ event, context }) => {
  await context.db
    .insert(schema.shieldActivity)
    .values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      kind: "unshield",
      account: lc(event.args.receiver),
      amount: event.args.cleartextAmount,
      blockNumber: event.block.number,
      txHash: event.transaction.hash,
      timestamp: event.block.timestamp,
    })
    .onConflictDoNothing();
});

// ── ACL delegation granted to our holder → record + BACKFILL ──────────────────
// (config filters these to delegate == holder). Re-attempt the delegator's
// pending transfers via delegated decryption; flip any we can now read.
ponder.on("Acl:DelegatedForUserDecryption", async ({ event, context }) => {
  const delegator = lc(event.args.delegator);
  const delegate = lc(event.args.delegate);

  await context.db
    .insert(schema.delegation)
    .values({
      id: `${delegator}-${delegate}`,
      delegator,
      delegate,
      active: true,
      expirationDate: event.args.newExpirationDate,
      updatedBlock: event.block.number,
    })
    .onConflictDoUpdate(() => ({
      active: true,
      expirationDate: event.args.newExpirationDate,
      updatedBlock: event.block.number,
    }));

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
    const outcome = await decryptAmountAs(row.amountHandle, TOKEN, delegator);
    if (outcome.status !== "decrypted") continue;
    await context.db.update(schema.transfer, { id: row.id }).set({
      amountClear: outcome.value,
      status: "decrypted",
      decryptedAt: event.block.timestamp,
      decryptAttempts: row.decryptAttempts + 1,
    });
  }
});

// ── ACL delegation revoked → mark inactive (keep already-decrypted history) ───
ponder.on("Acl:RevokedDelegationForUserDecryption", async ({ event, context }) => {
  const delegator = lc(event.args.delegator);
  const delegate = lc(event.args.delegate);
  await context.db
    .insert(schema.delegation)
    .values({
      id: `${delegator}-${delegate}`,
      delegator,
      delegate,
      active: false,
      expirationDate: null,
      updatedBlock: event.block.number,
    })
    .onConflictDoUpdate(() => ({ active: false, updatedBlock: event.block.number }));
});

// ── Periodic safety-net: retry transient "failed" decryptions (bounded) ───────
ponder.on("RetryDecryptions:block", async ({ event, context }) => {
  const failed = await context.db.sql
    .select()
    .from(schema.transfer)
    .where(
      and(eq(schema.transfer.status, "failed"), lt(schema.transfer.decryptAttempts, MAX_ATTEMPTS)),
    )
    .limit(RETRY_BATCH);

  for (const row of failed) {
    const outcome = await decryptAmount(row.amountHandle, TOKEN);
    await context.db.update(schema.transfer, { id: row.id }).set(
      outcome.status === "decrypted"
        ? {
            amountClear: outcome.value,
            status: "decrypted",
            decryptedAt: event.block.timestamp,
            decryptAttempts: row.decryptAttempts + 1,
          }
        : { status: outcome.status, decryptAttempts: row.decryptAttempts + 1 },
    );
  }
});
