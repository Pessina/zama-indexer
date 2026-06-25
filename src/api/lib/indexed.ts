import { db } from "ponder:api";
import schema from "ponder:schema";
import { and, or, eq, lt, desc, max } from "ponder";
import type { Hex } from "viem";
import type { Cursor } from "./cursor";

export type Direction = "in" | "out" | "all";

// Highest indexed block — a lower bound on the sync head (Ponder's /status is exact).
export async function indexedHead(): Promise<number> {
  const [t] = await db.select({ h: max(schema.transfer.blockNumber) }).from(schema.transfer);
  return Number(t?.h ?? 0n);
}

// Does any amount in this address's history still lack cleartext that a delegation could
// unlock (a `pending` row)?
export async function hasPending(address: Hex): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.transfer.id })
    .from(schema.transfer)
    .where(
      and(
        eq(schema.transfer.status, "pending"),
        or(eq(schema.transfer.fromAddress, address), eq(schema.transfer.toAddress, address)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

// Keyset seek: (blockNumber, logIndex) < (cursor.block, cursor.log), newest-first.
function seek(cursor: Cursor | null) {
  return cursor
    ? or(
        lt(schema.transfer.blockNumber, cursor.block),
        and(
          eq(schema.transfer.blockNumber, cursor.block),
          lt(schema.transfer.logIndex, cursor.log),
        ),
      )
    : undefined;
}

// One page (+1 to detect more) of activity touching the address — P2P transfers plus
// shields (mint, to==address → "in") and unshields (burn, from==address → "out"). The
// from/to direction predicate classifies all three;
export function pageTransfers(
  address: Hex,
  direction: Direction,
  cursor: Cursor | null,
  limit: number,
) {
  const dir =
    direction === "in"
      ? eq(schema.transfer.toAddress, address)
      : direction === "out"
        ? eq(schema.transfer.fromAddress, address)
        : or(eq(schema.transfer.fromAddress, address), eq(schema.transfer.toAddress, address));
  return db
    .select()
    .from(schema.transfer)
    .where(and(dir, seek(cursor)))
    .orderBy(desc(schema.transfer.blockNumber), desc(schema.transfer.logIndex))
    .limit(limit + 1);
}
