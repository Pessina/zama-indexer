import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import { config } from "../../config";
import { zama, tokenMeta } from "../lib/zama-client";
import { ApiError, normalizeAddress } from "../lib/errors";
import { AddressParam, BalanceResponse, ProblemSchema } from "../lib/schemas";

const holder = normalizeAddress(config.holderAddress);
const token = normalizeAddress(config.tokenAddress);

// GET /v1/addresses/:address/balance — authoritative cleartext balance, read live.
// The holder decrypts its own handle directly; for anyone else we attempt the
// delegated path, and "not entitled" becomes an actionable `indeterminate`.
export const balanceRoute = createRoute({
  method: "get",
  path: "/v1/addresses/{address}/balance",
  request: { params: AddressParam },
  responses: {
    200: {
      description: "Current cleartext balance, or an actionable `indeterminate`.",
      content: { "application/json": { schema: BalanceResponse } },
    },
    400: {
      description: "Invalid address.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    503: {
      description: "Decryption temporarily unavailable (transient).",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

export const balanceHandler: RouteHandler<typeof balanceRoute> = async (c) => {
  const address = normalizeAddress(c.req.valid("param").address);
  const meta = await tokenMeta(config.tokenAddress);
  const asOfBlock = Number(await zama.publicClient.getBlockNumber());

  const outcome =
    address === holder
      ? await zama.readBalance(config.tokenAddress, address)
      : await zama.readBalance(config.tokenAddress, address, address);

  const base = { address, token, symbol: meta.symbol, decimals: meta.decimals, asOfBlock };

  if (outcome.status === "decrypted") {
    return c.json({ ...base, balance: outcome.value.toString(), status: "complete" as const }, 200);
  }
  if (outcome.status === "pending") {
    // Not entitled — a well-formed answer, not an error. The "how to unlock" (delegate
    // user-decryption to the holder) lives in the OpenAPI docs, not in every response.
    return c.json({ ...base, balance: null, status: "indeterminate" as const }, 200);
  }
  // "failed" — a transient RPC/decrypt error, distinct from a stable not-entitled answer.
  throw new ApiError(
    "decrypt_unavailable",
    503,
    "Balance temporarily undecryptable; retry shortly.",
  );
};
