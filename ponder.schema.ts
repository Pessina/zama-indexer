import { index, onchainTable } from "ponder";

// Decryption lifecycle of a confidential amount, as the API surfaces it:
//  - decrypted: cleartext obtained via the Zama SDK (we held the rights)
//  - pending:   we are not (yet) entitled — handle persisted, awaiting backfill
//  - failed:    a transient decrypt/RPC error — will be retried on the block sweep
export type DecryptStatus = "decrypted" | "pending" | "failed";

// from == 0x0 => mint (shield), to == 0x0 => burn (unshield), else a P2P transfer.
export type TransferKind = "mint" | "burn" | "transfer";

// One row per ConfidentialTransfer log — the single activity ledger. P2P transfers,
// plus shields (mint, from==0x0) and unshields (burn, to==0x0): every wrap/unwrap emits
// a ConfidentialTransfer (ERC7984._update), so shield/unshield activity lives here as
// mint/burn rows — no separate public-amount table. The encrypted `amountHandle` is
// always stored; `amountClear` is filled when we decrypt. A row is NEVER dropped for
// being undecryptable — it sits `pending` until backfilled.
export const transfer = onchainTable(
  "transfer",
  (t) => ({
    id: t.text().primaryKey(), // `${txHash}-${logIndex}` (the response derives txHash from this)
    fromAddress: t.hex().notNull(),
    toAddress: t.hex().notNull(),
    kind: t.text().$type<TransferKind>().notNull(),
    amountHandle: t.hex().notNull(), // bytes32 euint64 handle (topics[3])
    amountClear: t.bigint(), // null until decrypted
    status: t.text().$type<DecryptStatus>().notNull(),
    decryptAttempts: t.integer().notNull().default(0),
    blockNumber: t.bigint().notNull(), // with logIndex: the ordering + cursor key
    logIndex: t.integer().notNull(), // unique within a block → (blockNumber, logIndex) is a total order
    timestamp: t.bigint().notNull(), // display only (not an ordering key)
  }),
  (table) => ({
    fromIdx: index().on(table.fromAddress),
    toIdx: index().on(table.toAddress),
    statusIdx: index().on(table.status),
  }),
);

// NOTE: balances are NOT materialised or derived from this log. The read API serves
// the current balance by reading the live `confidentialBalanceOf` handle and decrypting
// it (see src/api/routes/balance.ts) — authoritative, with no summation. A cached
// balance keyed off the public from/to logs is a documented optimisation (DECISIONS.md).
