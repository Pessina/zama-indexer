# DECISIONS

## Decision log

### 1. Indexer framework: Ponder (over a hand-rolled viem loop or a subgraph)

**Decision.** I used Ponder, a TypeScript indexing framework. It hands me the parts I'd otherwise have to build and maintain myself: historical backfill, reorg-safe realtime sync, crash recovery from a checkpoint, a built-in database, and a Hono server I can add my own routes to. The two hard requirements map cleanly onto its model — confidential transfers and ACL delegation grants are both on-chain events (`ConfidentialTransfer` and `DelegatedForUserDecryption`, each with an SDK decoder), so decrypting on the fly and backfilling when a grant lands are just event handlers writing to tables Ponder already keeps reorg-safe. And one process both indexes and serves the API.

**Alternatives considered.** A **viem + cursor loop** would give me my own DB and server, but I'd hand-build the whole indexer. **Envio/HyperIndex/Subsquid/The Graph** give indexing for free, but none of them lets me add custom REST routes, so I'd be running a second HTTP server next to their GraphQL one (and with The Graph I also can't write my own cleartext back into its store).

### 2. Chain & test environment: local-only fhEVM stack (Anvil + forge-fhevm)

**Decision.** I ran against a local fhEVM stack (Anvil + forge-fhevm) using the SDK's `cleartext()` transport. The chain is entirely under my control, so tests deploy the contract, set up whatever history they need (a shield, some transfers, a delegation grant) ahead of time, and fund accounts with toy amounts right in the test setup. Nothing depends on a testnet RPC, a faucet, relayer rate limits, or other people's transactions on a shared chain. And `cleartext()` isn't a mock — it runs the real high-level decrypt path and enforces the real on-chain ACL.

**Trade-offs.** Local doesn't run real FHE crypto, ZK input proofs, or the hosted relayer/KMS round-trip, so I get no read on relayer latency, throughput, 429s, or KMS availability. That's the under-load behaviour I flag as least-confident in Decision 1.

### 3. Read API is read-only and crafts no transactions — the delegation hint is declarative, not calldata

**Decision.** The API never hands back a transaction to sign. The smoothest experience would be to do it for the partner: when they can't decrypt a value like a balance, the API could build the delegation transaction and return the calldata for them to sign and broadcast. I don't do that. A compromised API could swap in a malicious transaction, and a client that signs without reading it carefully loses funds. Instead the API returns a flag — `delegationRequired`, or `status: "indeterminate"` on the balance endpoint — and the docs tell the client which SDK call grants the holder decryption rights. The client builds and signs that itself, and the indexer fills in the cleartext on its own once the grant lands.

**Trade-off.** This one step asks the partner to use the SDK directly, so the first integration is a little more work. In exchange, the API stays read-only and never sits in the signing path.

## What I composed vs. wrote myself

**Composed (off-the-shelf).** Ponder for indexing — backfill, reorg-safe sync, crash recovery, the database, and the Hono server, all in one process (Decision 1). `@zama-fhe/sdk` for every decrypt and ACL operation, so I never reimplement any FHE myself. Hono with `@hono/zod-openapi` for the REST API and its OpenAPI docs. viem for chain reads. forge-fhevm for the local cleartext stack.

**Wrote by hand.** The glue specific to this project: the decrypt seam (`ZamaClient` plus the small, unit-tested `classifyDecryptError`) that turns an SDK result into a `decrypted | pending | failed` status I can store; the three Ponder handlers (decrypt inline, backfill when a delegation is granted, and a bounded retry sweep) over a single `transfer` table; the read API — balance, transfers, health — with cursor pagination, the RFC 9457 error format, and the `delegationRequired` / `indeterminate` signals that tell a client when an amount can't be decrypted yet; and a test harness that spins up its own local chain. The heavy lifting stays in the libraries.

## Reflection

### Least confident under partner load

**The inline decrypt in the `ConfidentialTransfer` handler (`src/index.ts`).** Each event is decrypted on the critical path: Ponder `await`s `zama.decryptTransfer(...)` before it writes the row. On the local chain that call is cheap and predictable (no RPC rate limits, no relayer/KMS round-trip), so it isn't a real bottleneck. On a real chain like Sepolia it becomes a relayer/KMS round-trip, and under load that `await` can take longer than the time between events. When that happens the indexer falls behind: `blocksBehind` grows and the transfer history at `/transfers` goes stale. Balance stays fresh, since it's read live from the chain rather than from the index.

**How I'd prove it.** Add a delay to the decrypt call and watch `blocksBehind` climb on `/v1/health`.

### What I cut / the next four hours

**Primary — wire up the real testnet (Sepolia `node()`) path.** This runs everything the local stack skips: a real RPC, the relayer/KMS round-trip, real FHE crypto, ZK input proofs, and the real ACL-grant propagation delay (a minute or two that `cleartext()` never sees). Once it's wired up I can actually load-test it: send a burst of transfers and watch for latency, 429s/5xx, decrypts being re-run after reorgs, and `blocksBehind` growing without bound. That's the under-load risk from above.

Other things I left out:

1. **Cache the live balance, with invalidation I can prove is correct.** A confidential balance only changes through a `ConfidentialTransfer` (including mint and burn), and that event's `from`/`to` are public, so the indexer already records every block where an address's balance could have changed. I'd cache `{ balance, asOfBlock }` and serve it for free whenever no indexed transfer touches the address after `asOfBlock` — as long as the indexer is caught up to the chain head (the lag `/v1/health` reports). That turns a repeated balance read into a single lookup against the indexed log.
2. **Index the public shield/unshield amounts — no decryption needed.** The shield and unshield-finalize events (`Wrap` and `UnwrapFinalized`) carry their amounts in cleartext on-chain, so reading them needs no decrypt rights and no delegation. Indexing them would show shield/unshield amounts even when the indexer can't decrypt, instead of leaving them `pending` like it does today.
3. **Test the decrypt-error classification harder — I'm not fully confident in it.** When a decrypt comes back empty, the indexer has to decide whether that's permanent (not entitled yet, so wait for a grant → `pending`) or a temporary glitch worth retrying (`failed`). That decision leans partly on matching the SDK's error messages, and I'm not sure the matching holds for every failure the SDK can raise. I'd add more tests here, especially the failure modes the local stack can't reproduce, so I never mark something I could actually decrypt as a permanent failure — and so a wrong guess is recoverable instead of quietly stranding a row.

### SDK feedback

Three asks, in priority order (1 = most urgent). The list order is the rank; where urgency and correctness pull apart, the (c) note says so.

1. **Bundle a deployable token into the local stack.** **(a)** forge-fhevm's `deploy-local.sh` brings up the FHE host contracts (ACL, executor, KMS, input verifier) with no config, and the `local-development` guide covers the `cleartext()` transport — but neither one deploys an actual token, so you wire up a mintable ERC20 + `ConfidentialWrapperV3` yourself. Folding that into the local deploy would give you a working ERC-7984 token alongside the host stack. **(b)** It's the one step between "the host stack is up" and "I have a token to test against," and right now every integrator rewrites the same ERC20 → wrapper → registry deploy. **(c)** Priority 1 — the first real blocker: nothing else can be exercised until a token exists on the local stack, and it's nearly free since the deploy script already lives in the SDK's `contracts/`, just not bundled. Pairs with #3.
2. **Expose a stable signal for decrypt-error classification — a `.code`, or the `isTransientError` check.** **(a)** Today `classifyDecryptError` decides pending-vs-failed by matching substrings in `err.message`, which breaks the day a message is reworded. Give me something stable to route on instead: either a `.code` on every decrypt error, or the `isTransientError` verdict the SDK already computes internally to retry before surfacing the failure. **(b)** It's the call the indexer makes on every undecryptable transfer — "wait for a grant → pending" vs "transient → retry later" — and a stable signal lets the classifier route on the SDK's own determination rather than a brittle regex. **(c)** Priority 2, and the highest-**correctness** of the three: it decides pending-vs-failed, the core domain rule and the classification I flag above as the one I'm least sure of. It ranks second only on **urgency** — the string-match workaround is good enough today, so unlike #1 it isn't a first-hour blocker — and it just surfaces logic the SDK already has, so it's a small addition.
3. **Export ready-to-use contract ABIs.** **(a)** Ship the ERC-7984-wrapper and ACL ABI arrays (including the delegation _events_) from the package. Today it exports decoders and topic constants, but no ABI you can hand to a tool. **(b)** That lets any ABI-driven indexer (Ponder, a subgraph, viem/wagmi) wire up an ERC-7984 token without hand-writing the event fragments — the same thing viem already does by shipping `erc20Abi`/`erc721Abi`, so the SDK is the natural home for these. **(c)** Priority 3 (Medium) — a real convenience and nearly free since the ABIs already exist in the SDK repo, but the most deferrable of the three: you can hand-write the event fragments today, so nothing is blocked without it.

### AI assistance

I built this with Claude Code (Claude Opus) as my main tool.

**Process.**

1. **Explore the primitives and set up the AI groundwork before writing any code.** The first pass is pure research: which indexing tool to use (Ponder vs a hand-rolled viem loop vs a subgraph), local fhEVM vs Sepolia, the database schema, and how the SDK actually does user-decryption and ACL delegation. Alongside that I set up the AI groundwork in the repo — a project `CLAUDE.md`, task-specific skills (`ponder-indexer`, `zama-sdk`), hooks, and a checked-out `zama-ai/sdk` clone next door (`../sdk`, on the **`prerelease`** branch that tracks the alpha) — so every session reads from real source on disk under fixed rules instead of relying on stale training data. The output of this phase is the design doc and the decision log above, not code.
2. **Plan the build as a dependency DAG and parallelize along it.** I break the work into a dependency DAG and run it in waves: the groundwork and the local-chain setup (Anvil + forge-fhevm) go first and in parallel, and finishing them unblocks the three read endpoints (balance, transfers, health), which then run in parallel too. Each task runs through the full superpowers pipeline — brainstorming, then writing-plans, then review, then implementation — and I review the diff before it lands.
3. **TDD as a standing rule, then mutation-test the tests.** My global rules push every change through TDD, which makes the model think about each change twice — once as the code, once as the test that pins it down — and the two have to line up, so a mismatch shows up as a failing test right away (the classifier's first test failed on a missing export before the function even existed). Then I have it run a mutation pass: it breaks its own code and checks that a specific test catches each break, so I know the tests actually catch regressions instead of just passing. And before a change comes back to me, the model reviews its own diff and confirms the tests are green, so what I'm reviewing is already checked rather than raw output. The decrypt classifier (`classifyDecryptError`) is a pure function pinned by a fast, chain-free unit suite (`pnpm test:unit`) built exactly this way.

**Where the model was subtly wrong (and how I caught it).**

1. **Deriving the balance from the transfer log instead of reading the on-chain value.** Adding up the log (incoming minus outgoing, with shields and unshields as deltas) is the standard way ERC-20 _indexers_ track balances, and a basic test passes — but the moment any amount is `pending` or `failed`, the sum quietly returns a confident wrong number, which is exactly the failure the brief warns about. I pointed it at the authoritative read instead: fetch and decrypt the `confidentialBalanceOf` handle. One value, one entitlement check, no guessing at partial state.
2. **A decrypt path that only handled the holder directly.** Its first version only decrypted amounts the holder was a _party_ to. It looked complete because the grant handler backfills whenever a new delegation lands, which hid the fact that an amount already covered by an existing delegation would sit `pending` until some later grant happened to fire. I had it check `delegations.isActive` for each counterparty and decrypt through the delegated path when one is active.
3. **Matching error strings instead of using the SDK's own dispatcher.** Its first classifier matched substrings in `err.message` — brittle, and it missed that the SDK already ships a dispatcher keyed on the error code. I had it search the local `sdk/` clone to check, which turned up `matchZamaError`; switching to `.code` left string-matching for just the one ACL "not entitled" case that has no code (SDK feedback #2).
