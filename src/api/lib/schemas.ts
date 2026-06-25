// Shared zod schemas (the `z` extended by @hono/zod-openapi) — the validated request
// contract AND the generated OpenAPI 3.1 spec. Per-status / per-entitlement meaning
// lives here in `description`s (in-band code, out-of-band semantics), so responses
// carry codes, not prose.
import { z } from "@hono/zod-openapi";
import { config } from "../../config";

export const AddressParam = z.object({
  address: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .openapi({
      param: { name: "address", in: "path" },
      description: "0x-prefixed 20-byte EVM address (case-insensitive; normalised to lowercase).",
      example: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    }),
});

export const TransfersQuery = z.object({
  cursor: z.string().optional().openapi({
    description: "Opaque pagination cursor from a previous page's `nextCursor`.",
    example: "NDU1NTo3",
  }),
  limit: z.coerce.number().int().optional().openapi({
    description: "Max items to return (1–100, default 25; out-of-range values are clamped).",
    example: 25,
  }),
  direction: z.enum(["in", "out", "all"]).default("all").openapi({
    description:
      "Filter relative to the address: `in` (received transfers + shields), `out` (sent transfers + unshields), `all`.",
    example: "all",
  }),
});

const StatusEnum = z.enum(["decrypted", "pending", "failed"]).openapi({
  description:
    "Amount state. `decrypted`: cleartext the indexer decrypted. `pending`: encrypted, the indexer lacks rights — see `delegationRequired`. `failed`: a transient decrypt/RPC error, retried in the background.",
});

const KindEnum = z.enum(["transfer", "shield", "unshield"]).openapi({
  description: "`transfer` (P2P confidential), `shield` (wrap-in), `unshield` (unwrap-out).",
});

export const TransferItem = z
  .object({
    id: z.string().openapi({ description: "Stable id: `${txHash}-${logIndex}`." }),
    kind: KindEnum,
    from: z
      .string()
      .openapi({ description: "Sender, verbatim from the event; the zero address for shields." }),
    to: z.string().openapi({
      description: "Recipient, verbatim from the event; the zero address for unshields.",
    }),
    amount: z
      .string()
      .nullable()
      .openapi({ description: "Base-unit decimal string, or null when not decrypted." }),
    status: StatusEnum,
    blockNumber: z.string(),
    txHash: z.string(),
    logIndex: z.number().int(),
    timestamp: z.string().openapi({ description: "Unix seconds (string)." }),
  })
  .openapi("TransferItem");

// Token-metadata envelope, spread into every read response that carries amounts. Design
// principle: return exactly enough to interpret the payload; make optional/expensive data
// opt-in. `decimals` is load-bearing here — `amount`/`balance` are base-unit integers, so a
// client needs the scale (10^decimals) to render them; inlining keeps each response
// self-describing and avoids a round-trip or on-chain read.
const tokenEnvelope = {
  token: z
    .string()
    .openapi({ description: "Address of the confidential token this response describes." }),
  symbol: z.string().openapi({ description: "Token symbol — a display label, e.g. `cUSDT`." }),
  decimals: z.number().int().openapi({
    description:
      "Token decimals. `amount`/`balance` are base-unit integers; divide by 10^decimals for whole units.",
  }),
};

export const TransfersResponse = z
  .object({
    address: z.string(),
    ...tokenEnvelope,
    indexedBlock: z
      .number()
      .int()
      .openapi({ description: "Sync height the history is authoritative as-of." }),
    items: z.array(TransferItem),
    delegationRequired: z.boolean().openapi({
      description:
        "True when the indexer holds no decrypt rights for some of this address's amounts (rows with " +
        "`status: pending`, shown as `null`). To reveal them, grant a user-decryption delegation to the " +
        `indexer holder (${config.holderAddress}) on the token (${config.tokenAddress}) via the Zama SDK ` +
        "`delegations.delegateDecryption({ contractAddress, delegateAddress })` — verify the holder against " +
        "the indexer's published identity before signing; amounts backfill automatically once the grant " +
        "propagates. False when this address is the holder, or nothing is pending.",
    }),
    nextCursor: z
      .string()
      .nullable()
      .openapi({ description: "Cursor for the next page, or null." }),
  })
  .openapi("TransfersResponse");

export const BalanceResponse = z
  .object({
    address: z.string(),
    ...tokenEnvelope,
    asOfBlock: z.number().int().openapi({ description: "Block height the balance was read at." }),
    balance: z
      .string()
      .nullable()
      .openapi({ description: "Base-unit decimal string; null when status is `indeterminate`." }),
    status: z.enum(["complete", "indeterminate"]).openapi({
      description:
        "`complete`: authoritative cleartext balance. `indeterminate`: the indexer lacks decrypt rights for this address — grant a user-decryption delegation to the holder (see `delegationRequired` on the transfers endpoint).",
    }),
  })
  .openapi("BalanceResponse");

export const HealthResponse = z
  .object({
    chainId: z.number().int().openapi({ description: "The chain this indexer watches." }),
    indexedBlock: z.number().int().openapi({
      description:
        "Highest block the indexer has processed (Ponder's authoritative sync checkpoint).",
    }),
    headBlock: z.number().int().openapi({ description: "Current chain head." }),
    blocksBehind: z
      .number()
      .int()
      .openapi({
        description:
          "headBlock − indexedBlock, clamped at 0: how far the indexer trails the chain (0 = caught up). " +
          "This endpoint owns the one number Ponder's built-ins don't: readiness (still backfilling vs. live) " +
          "is the `/ready` probe, and raw indexed height is `/status`.",
      }),
  })
  .openapi("HealthResponse");

// RFC 9457 Problem Details (response side). `type` points into these docs; `code` is
// the stable machine key.
export const ProblemSchema = z
  .object({
    type: z.string(),
    code: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string(),
  })
  .openapi("Problem");
