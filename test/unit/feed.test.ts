import { describe, expect, test } from "vitest";
import { transferToItem, type TransferRow } from "../../src/api/lib/feed";

const ADDR = "0xaaaa000000000000000000000000000000000001";
const OTHER = "0xbbbb000000000000000000000000000000000002";
const ZERO = "0x0000000000000000000000000000000000000000";

const row = (o: Partial<TransferRow> = {}): TransferRow => ({
  id: "0xtx-1",
  kind: "transfer",
  fromAddress: ADDR,
  toAddress: OTHER,
  amountClear: 5n,
  status: "decrypted",
  blockNumber: 100n,
  logIndex: 1,
  timestamp: 1000n,
  ...o,
});

describe("transferToItem", () => {
  test("p2p transfer passes through from/to verbatim, amount stringified", () => {
    expect(transferToItem(row())).toMatchObject({
      kind: "transfer",
      from: ADDR,
      to: OTHER,
      amount: "5",
      status: "decrypted",
    });
  });

  test("mint → shield, from is the zero address", () => {
    expect(transferToItem(row({ kind: "mint", fromAddress: ZERO, toAddress: ADDR }))).toMatchObject(
      {
        kind: "shield",
        from: ZERO,
        to: ADDR,
      },
    );
  });

  test("burn → unshield, to is the zero address", () => {
    expect(transferToItem(row({ kind: "burn", fromAddress: ADDR, toAddress: ZERO }))).toMatchObject(
      {
        kind: "unshield",
        from: ADDR,
        to: ZERO,
      },
    );
  });

  test("txHash is derived from the id prefix", () => {
    expect(transferToItem(row({ id: "0xabc123-7" })).txHash).toBe("0xabc123");
  });

  test("undecrypted (amountClear null) → amount null", () => {
    expect(transferToItem(row({ amountClear: null, status: "pending" })).amount).toBeNull();
  });
});
