import { index, onchainTable } from "ponder";

// Decryption lifecycle of a confidential amount, as the API surfaces it:
//  - decrypted: cleartext obtained via the Zama SDK (we held the rights)
//  - public:    amount was already public on-chain (shield/unshield legs)
//  - pending:   we are not (yet) entitled — handle persisted, awaiting backfill
//  - failed:    a transient decrypt/relayer error — will be retried
export type DecryptStatus = "decrypted" | "public" | "pending" | "failed";

// from == 0x0 => mint (shield), to == 0x0 => burn (unshield), else a P2P transfer.
export type TransferKind = "mint" | "burn" | "transfer";

// One row per ConfidentialTransfer log. The encrypted `amountHandle` is always
// stored; `amountClear` is filled when we decrypt (or already-public). A row is
// NEVER dropped for being undecryptable — it sits `pending` until backfilled.
export const transfer = onchainTable(
  "transfer",
  (t) => ({
    id: t.text().primaryKey(), // `${txHash}-${logIndex}`
    fromAddress: t.hex().notNull(),
    toAddress: t.hex().notNull(),
    kind: t.text().$type<TransferKind>().notNull(),
    amountHandle: t.hex().notNull(), // bytes32 euint64 handle (topics[3])
    amountClear: t.bigint(), // null until decrypted / public
    status: t.text().$type<DecryptStatus>().notNull(),
    decryptAttempts: t.integer().notNull().default(0),
    blockNumber: t.bigint().notNull(),
    txHash: t.hex().notNull(),
    logIndex: t.integer().notNull(),
    timestamp: t.bigint().notNull(),
    decryptedAt: t.bigint(), // unix seconds, set when resolved
  }),
  (table) => ({
    fromIdx: index().on(table.fromAddress),
    toIdx: index().on(table.toAddress),
    statusIdx: index().on(table.status),
  }),
);

// NOTE: balances are NOT materialised in a table. They are derived on read from
// the decrypted transfer log (sum of `to` credits minus `from` debits, with a
// count of still-`pending` transfers so the API can flag an incomplete balance).
// Deriving keeps the handlers simple and the balance always consistent with the
// log; a materialised balance table is the obvious optimisation under load.

// Delegations granted TO the indexer's holder (drives backfill). Keyed by
// (delegator, delegate) so re-grants/revokes upsert the same row.
export const delegation = onchainTable(
  "delegation",
  (t) => ({
    id: t.text().primaryKey(), // `${delegator}-${delegate}`
    delegator: t.hex().notNull(),
    delegate: t.hex().notNull(),
    active: t.boolean().notNull(),
    expirationDate: t.bigint(),
    updatedBlock: t.bigint().notNull(),
  }),
  (table) => ({
    delegateIdx: index().on(table.delegate),
  }),
);

// Shield (wrap) / unshield (unwrap-finalize) activity — these legs carry a
// PUBLIC cleartext amount, so no decryption is needed.
export const shieldActivity = onchainTable("shield_activity", (t) => ({
  id: t.text().primaryKey(), // `${txHash}-${logIndex}`
  kind: t.text().$type<"shield" | "unshield">().notNull(),
  account: t.hex().notNull(),
  amount: t.bigint().notNull(), // public cleartext (roundedAmount / cleartextAmount)
  blockNumber: t.bigint().notNull(),
  txHash: t.hex().notNull(),
  timestamp: t.bigint().notNull(),
}));
