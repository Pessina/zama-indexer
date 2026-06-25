// End-to-end proof of the indexer-health read. Boots the real indexer against the
// provisioned local chain, lets it catch up to head, then asserts GET /v1/health. This
// exercises the real composition — a self-call to Ponder's own /status (indexed
// checkpoint) plus a live head read via publicClients — not a mock. Unlike balance.e2e
// (db-free, mounted in-process), health imports `ponder:api` and self-calls /status, so
// it needs the full booted server.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { startIndexer, type RunningIndexer } from "./setup/indexer";

type Health = {
  chainId: number;
  indexedBlock: number;
  headBlock: number;
  blocksBehind: number;
};

let indexer: RunningIndexer;

beforeAll(async () => {
  // No events to drive — startIndexer returns only once indexed height >= chain head,
  // so the indexer is caught up by the time we assert.
  indexer = await startIndexer();
}, 180_000);

afterAll(async () => {
  await indexer?.stop();
});

describe("GET /v1/health (booted indexer)", () => {
  test("a caught-up indexer reports lag-only health, blocksBehind ~0", async () => {
    const res = await fetch(`${indexer.baseUrl}/v1/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Health;

    // Trimmed shape: lag only — no `status` verdict, no `secondsBehind`.
    expect(Object.keys(body).sort()).toEqual([
      "blocksBehind",
      "chainId",
      "headBlock",
      "indexedBlock",
    ]);

    expect(body.chainId).toBe(31337);
    expect(body.indexedBlock).toBeGreaterThan(0);
    expect(body.headBlock).toBeGreaterThanOrEqual(body.indexedBlock);
    // blocksBehind is the clamped lag, and a caught-up indexer trails head by ~0.
    expect(body.blocksBehind).toBe(Math.max(0, body.headBlock - body.indexedBlock));
    expect(body.blocksBehind).toBeLessThanOrEqual(1);
  });
});
