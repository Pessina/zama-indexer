// Pure mapping of `transfer` rows into the unified history feed. No db, no SDK —
// testable in isolation. Shields/unshields are the mint/burn rows (from/to == 0x0):
// every wrap/unwrap emits a ConfidentialTransfer, so the single table is the whole feed.

export type Item = {
  id: string;
  kind: "transfer" | "shield" | "unshield";
  from: string;
  to: string;
  amount: string | null;
  status: "decrypted" | "pending" | "failed";
  blockNumber: string;
  txHash: string;
  logIndex: number;
  timestamp: string;
};

// Structural input — the Drizzle `transfer` row is assignable to this.
export type TransferRow = {
  id: string;
  kind: "mint" | "burn" | "transfer";
  fromAddress: string;
  toAddress: string;
  amountClear: bigint | null;
  status: "decrypted" | "pending" | "failed";
  blockNumber: bigint;
  logIndex: number;
  timestamp: string | bigint;
};

export function transferToItem(row: TransferRow): Item {
  const kind = row.kind === "mint" ? "shield" : row.kind === "burn" ? "unshield" : "transfer";
  return {
    id: row.id,
    kind,
    from: row.fromAddress,
    to: row.toAddress,
    amount: row.amountClear !== null ? row.amountClear.toString() : null,
    status: row.status,
    blockNumber: row.blockNumber.toString(),
    txHash: row.id.slice(0, row.id.indexOf("-")), // derived from id (txHash-logIndex)
    logIndex: row.logIndex,
    timestamp: row.timestamp.toString(),
  };
}
