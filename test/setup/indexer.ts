// Boot the real indexer (`ponder dev`) against the already-provisioned local chain
// for the end-to-end history test: drive on-chain events first, then start the
// indexer so it backfills them deterministically, and hand back the base URL once it
// has caught up to the chain head. Teardown kills the whole process group
// (pnpm → ponder → node).
//
// `ponder dev`, not `start`: `start` is the production command and resumes a previous run
// against the same database schema (crash recovery) rather than reindexing. `dev` is the
// documented dev-server command; combined with wiping `.ponder` below (which empties the
// embedded pglite DB), every run is a deterministic fresh index. (`--schema` is optional
// for both in 0.16 — the real difference is resume-vs-reindex, not a required flag.)
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { createPublicClient, http } from "viem";
import { foundry } from "viem/chains";
import { LOCAL_RPC } from "../../src/anvil";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type RunningIndexer = { baseUrl: string; stop: () => Promise<void> };

// An OS-assigned free port that THIS run owns. The harness must pin the indexer's port:
// `ponder dev` silently falls back to the next port when its target is busy (`--port` is a
// preference, not a lock), so a hardcoded 42069 means that if anything already holds it (a
// leftover `pnpm dev`, a prior run's leak) the real server lands on 42070 while we poll the
// stale process on 42069 forever — i.e. a 180s hook timeout, not a boot failure. Bind :0,
// read the port the OS hands us, release it, and pass it straight to `ponder dev`.
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("could not acquire a free port"))));
    });
  });
}

// Highest block the indexer reports across chains (Ponder's built-in /status). A short
// abort keeps a slow/stuck response from stalling the catch-up loop past its deadline.
async function indexedBlock(baseUrl: string): Promise<bigint> {
  try {
    const res = await fetch(`${baseUrl}/status`, { signal: AbortSignal.timeout(2000) });
    const s = (await res.json()) as Record<string, { block?: { number?: number } }>;
    const blocks = Object.values(s).map((v) => BigInt(v?.block?.number ?? 0));
    return blocks.reduce((a, b) => (a > b ? a : b), 0n);
  } catch {
    return 0n;
  }
}

export async function startIndexer(): Promise<RunningIndexer> {
  // Fresh index every run: wipe Ponder's embedded pglite DB + build cache under .ponder
  // so `dev` reindexes from scratch instead of resuming a previous run.
  await rm(".ponder", { recursive: true, force: true });

  // The chain head the indexer must reach (events were driven before this call).
  const client = createPublicClient({ chain: foundry, transport: http(LOCAL_RPC) });
  const head = await client.getBlockNumber();

  // Pin a free port and pass it to `ponder dev` (and PORT, which the health route's
  // self-call origin falls back to) so we always poll the server we just spawned.
  const port = await getFreePort();
  const baseUrl = `http://localhost:${port}`;
  const child = spawn("pnpm", ["dev", "--", "--port", String(port)], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
    detached: true, // own process group → reliable teardown
  });

  const stop = async (): Promise<void> => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGINT");
    } catch {
      /* already gone */
    }
    await sleep(1500);
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  };

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await sleep(1500);
    try {
      // In 0.16 `/ready` already returns 200 only once realtime has reached the chain
      // tip, so it implies the head is indexed. The `>= head` gate is defensive: confirm
      // the just-driven events are indexed, not merely that the server is up.
      const ready = await fetch(`${baseUrl}/ready`, { signal: AbortSignal.timeout(2000) });
      if (ready.ok && (await indexedBlock(baseUrl)) >= head) return { baseUrl, stop };
    } catch {
      /* server not up yet */
    }
  }
  await stop();
  throw new Error(
    `Indexer did not catch up to head (${head}) within 120s (chain up? contracts deployed?)`,
  );
}
