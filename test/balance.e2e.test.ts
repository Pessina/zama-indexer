import { afterAll, beforeAll, describe, expect, inject, test } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { OpenAPIHono } from "@hono/zod-openapi";
import { balanceRoute, balanceHandler } from "../src/api/routes/balance";
import { zama } from "../src/api/lib/zama-client";
import { onError, problem } from "../src/api/lib/errors";
import { TestActor } from "./helpers/actor";
import { ANVIL_KEYS } from "../src/anvil";

const DECIMALS = 6n;
const units = (whole: bigint): bigint => whole * 10n ** DECIMALS;
const { cUSDT } = inject("deployments");

const holder = privateKeyToAccount(ANVIL_KEYS.acct0).address.toLowerCase();
const unused = privateKeyToAccount(ANVIL_KEYS.acct3).address.toLowerCase();
const stranger = new TestActor(ANVIL_KEYS.acct1);

// Balance is db-free (it reads live chain state), so we mount ONLY the balance route on
// a fresh app and drive it in-process — no indexer subprocess, no `ponder:api` import.
// The validation hook mirrors src/api/index.ts so a malformed address renders as an
// RFC 9457 Problem, not the default zod error.
const app = new OpenAPIHono({
  defaultHook: (result, c) => {
    if (!result.success) {
      const code = result.target === "param" ? "invalid_address" : "invalid_request";
      return problem(c, code, 400, result.error.issues.map((i) => i.message).join("; "));
    }
    return undefined;
  },
});
app.onError(onError);
app.openapi(balanceRoute, balanceHandler);

beforeAll(async () => {
  // Give the stranger a non-zero, non-delegated balance so it is the indeterminate
  // case (not the zero-handle case). Exact amount is irrelevant — we assert status.
  await stranger.mintAndShield(cUSDT, units(50n));
}, 120_000);

afterAll(() => {
  stranger.terminate();
  zama.terminate();
});

const get = async (addr: string): Promise<Response> => app.request(`/v1/addresses/${addr}/balance`);

describe("GET /v1/addresses/:address/balance", () => {
  test("happy path: holder's balance is exact cleartext (event in → cleartext out)", async () => {
    const res = await get(holder);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      address: holder,
      status: "complete",
      // 1,000 cUSDT is the deploy-time seed: Deploy.s.sol wraps 1_000 * 1e6 to the holder (acct0).
      balance: units(1000n).toString(),
      decimals: 6,
    });
  });

  test("zero-handle address reads as 0 / complete", async () => {
    const res = await get(unused);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "complete", balance: "0" });
  });

  test("negative: un-entitled balance is indeterminate — never wrong, never dropped", async () => {
    const res = await get(stranger.address);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; balance: string | null };
    expect(body.status).toBe("indeterminate");
    expect(body.balance).toBeNull();
  });

  test("malformed address → 400 problem (application/problem+json, code invalid_address)", async () => {
    const res = await get("0xNOTANADDRESS");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(((await res.json()) as { code: string }).code).toBe("invalid_address");
  });
});
