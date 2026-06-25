export type Cursor = { block: bigint; log: number };

// Opaque keyset cursor: base64url of `${block}:${log}`. The pair (blockNumber,
// logIndex) is unique within a block, so it is a stable total-order seek key.
export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.block.toString()}:${c.log.toString()}`).toString("base64url");
}

// Decode never throws — any absent/malformed/tampered value yields null, and the
// route then serves the first page (treats it as "no cursor").
export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const parts = Buffer.from(raw, "base64url").toString("utf8").split(":");
    if (parts.length !== 2) return null;
    const [b, l] = parts;
    if (b === undefined || l === undefined || !/^\d+$/.test(b) || !/^\d+$/.test(l)) return null;
    return { block: BigInt(b), log: Number(l) };
  } catch {
    return null;
  }
}
