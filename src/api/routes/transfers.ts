import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import { config } from "../../config";
import { tokenMeta } from "../lib/zama-client";
import { normalizeAddress } from "../lib/errors";
import { decodeCursor, encodeCursor } from "../lib/cursor";
import { transferToItem } from "../lib/feed";
import { indexedHead, hasPending, pageTransfers } from "../lib/indexed";
import { AddressParam, TransfersQuery, TransfersResponse, ProblemSchema } from "../lib/schemas";

const HOLDER = normalizeAddress(config.holderAddress);
const TOKEN = normalizeAddress(config.tokenAddress);

// GET /v1/addresses/:address/transfers — unified, newest-first history feed. Pure
// reader: serves stored cleartext + per-row status (it never decrypts on read), plus
// a single `delegationRequired` flag — the one signal a client acts on.
export const transfersRoute = createRoute({
  method: "get",
  path: "/v1/addresses/{address}/transfers",
  request: { params: AddressParam, query: TransfersQuery },
  responses: {
    200: {
      description: "Paginated transfer history; cleartext amounts where available.",
      content: { "application/json": { schema: TransfersResponse } },
    },
    400: {
      description: "Invalid address or query.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

export const transfersHandler: RouteHandler<typeof transfersRoute> = async (c) => {
  const address = normalizeAddress(c.req.valid("param").address);
  const q = c.req.valid("query");
  const limit = Math.min(Math.max(1, q.limit ?? 25), 100);
  const cursor = decodeCursor(q.cursor);

  const [rows, pending, head, meta] = await Promise.all([
    pageTransfers(address, q.direction, cursor, limit),
    hasPending(address),
    indexedHead(),
    tokenMeta(config.tokenAddress),
  ]);

  const items = rows.map((r) => transferToItem(r));
  const page = items.slice(0, limit);
  const hasMore = items.length > limit;
  const last = page.at(-1);
  const nextCursor =
    hasMore && last ? encodeCursor({ block: BigInt(last.blockNumber), log: last.logIndex }) : null;

  // The one action signal: does the partner need to grant a delegation to reveal hidden
  // amounts? True only when this address isn't the holder AND it has `pending` rows a
  // delegation would unlock. The how-to lives on the `delegationRequired` OpenAPI field.
  const delegationRequired = address !== HOLDER && pending;

  return c.json(
    {
      address,
      token: TOKEN,
      symbol: meta.symbol,
      decimals: meta.decimals,
      indexedBlock: head,
      items: page,
      delegationRequired,
      nextCursor,
    },
    200,
  );
};
