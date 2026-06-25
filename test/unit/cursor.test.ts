import { describe, expect, test } from "vitest";
import { encodeCursor, decodeCursor } from "../../src/api/lib/cursor";

describe("cursor", () => {
  test("round-trips block + log", () => {
    expect(decodeCursor(encodeCursor({ block: 4555n, log: 7 }))).toEqual({ block: 4555n, log: 7 });
  });

  test("is URL-safe (no + / =)", () => {
    expect(encodeCursor({ block: 123456789012345678n, log: 42 })).not.toMatch(/[+/=]/);
  });

  test("decodes block numbers beyond Number.MAX_SAFE_INTEGER losslessly", () => {
    const big = 99999999999999999999n;
    expect(decodeCursor(encodeCursor({ block: big, log: 0 }))).toEqual({ block: big, log: 0 });
  });

  test("undefined → null", () => {
    expect(decodeCursor(undefined)).toBeNull();
  });

  test.each(["", "!!!", "abc", "Zm9v", "notbase64$$", "NDU1NQ=="])(
    "malformed %j → null (never throws)",
    (raw) => {
      expect(decodeCursor(raw)).toBeNull();
    },
  );
});
