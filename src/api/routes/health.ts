import { createRoute, type RouteHandler } from "@hono/zod-openapi";
import { publicClients } from "ponder:api";
import { config } from "../../config";
import { ApiError } from "../lib/errors";
import { HealthResponse, ProblemSchema } from "../lib/schemas";

// GET /v1/health — indexer sync lag.
export const healthRoute = createRoute({
  method: "get",
  path: "/v1/health",
  responses: {
    200: {
      description: "Indexer sync lag: how far behind the chain head the indexer is.",
      content: { "application/json": { schema: HealthResponse } },
    },
    503: {
      description: "Chain RPC unreachable; lag cannot be determined.",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

export const healthHandler: RouteHandler<typeof healthRoute> = async (c) => {
  // Hit the same server the request arrived on — no port-guessing.
  let origin: string;
  try {
    origin = new URL(c.req.url).origin;
  } catch {
    origin = `http://127.0.0.1:${process.env.PORT ?? 42069}`;
  }

  // Ponder's /status decodes its internal sync checkpoint for us. A failure here is
  // non-fatal: treat indexed height as 0 (reads as "fully behind"), never a 503 —
  // only an unreadable chain head is a 503.
  let indexedBlock = 0;
  try {
    const res = await fetch(`${origin}/status`);
    if (res.ok) {
      const body = (await res.json()) as Record<
        string,
        { block?: { number?: number } } | undefined
      >;
      indexedBlock = body.fhevm?.block?.number ?? 0;
    }
  } catch {
    indexedBlock = 0;
  }

  let headBlock: number;
  try {
    headBlock = Number(await publicClients.fhevm.getBlockNumber());
  } catch {
    throw new ApiError("chain_unavailable", 503, "Chain RPC unreachable; cannot determine lag.");
  }

  return c.json(
    {
      chainId: config.chainId,
      indexedBlock,
      headBlock,
      blocksBehind: Math.max(0, headBlock - indexedBlock),
    },
    200,
  );
};
