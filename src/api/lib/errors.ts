import type { Context } from "hono";
import { isAddress, type Address } from "viem";

export type ErrorCode =
  | "invalid_address"
  | "invalid_request"
  | "decrypt_unavailable"
  | "chain_unavailable"
  | "not_found"
  | "internal";

type ProblemStatus = 400 | 404 | 500 | 503;

// Short, stable, type-level labels (RFC 9457 `title`). The per-code "what it means /
// what to do" lives in the OpenAPI docs reachable via the `type` URI — responses
// carry codes, not prose.
const TITLES: Record<ErrorCode, string> = {
  invalid_address: "Invalid address",
  invalid_request: "Invalid request",
  decrypt_unavailable: "Decryption temporarily unavailable",
  chain_unavailable: "Chain RPC unavailable",
  not_found: "Not found",
  internal: "Internal server error",
};

// A thrown ApiError is the sanctioned way a handler returns a non-2xx; `onError`
// renders it as a problem. `detail` is the occurrence-specific message.
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: ProblemStatus,
    detail: string,
  ) {
    super(detail);
    this.name = "ApiError";
  }
}

// RFC 9457 Problem Details. `type` is a relative URI into the OpenAPI docs (resolved
// against the request); `code` is a stable machine key (Stripe-style); `detail` is
// occurrence-specific. Content-Type is application/problem+json (the 3rd c.json arg
// overrides Hono's default application/json).
export function problem(
  c: Context,
  code: ErrorCode,
  status: ProblemStatus,
  detail: string,
): Response {
  return c.json(
    { type: `/docs#errors-${code}`, code, title: TITLES[code], status, detail },
    status,
    { "content-type": "application/problem+json" },
  );
}

export function onError(err: Error, c: Context): Response {
  if (err instanceof ApiError) return problem(c, err.code, err.status, err.message);
  return problem(c, "internal", 500, "Internal server error");
}

// Lowercase an already-validated address (the zod route layer validates the format).
export function normalizeAddress(raw: string): Address {
  return raw.toLowerCase() as Address;
}

// Validate + normalise a path address where no zod layer sits in front; invalid → a
// 400 ApiError that `onError` renders as an invalid_address problem.
export function parseAddress(raw: string | undefined): Address {
  if (!raw || !isAddress(raw)) {
    throw new ApiError("invalid_address", 400, `Invalid address: ${raw ?? "(missing)"}`);
  }
  return normalizeAddress(raw);
}
