# DECISIONS

Design notes and trade-offs for the `zama-indexer` confidential ERC-7984 indexer. See `TASK.md` (workspace root) for the brief this responds to.

> Draft — sections are stubbed and will be filled in as the build progresses.

## Overview

_What this service is, in two sentences._

_TODO_

## Decision log

### 1. Indexer framework: Ponder (over a hand-rolled viem loop or a subgraph)

**Decision.** Use Ponder, a TypeScript-native indexing framework, as the spine. It hands us the load-bearing but unglamorous infrastructure for free — historical backfill, reorg-safe realtime sync, crash-resume from a checkpoint, an embedded database, and an extensible Hono server — which is exactly the brief's instruction to compose existing primitives rather than write an EVM indexer from scratch. Both hard requirements fit its event-driven model natively: confidential transfers and ACL delegation grants are both on-chain events (`ConfidentialTransfer`, `DelegatedForUserDecryption`, each with an SDK decoder), so inline best-effort decryption and event-triggered backfill are just handlers updating the same reorg-tracked tables, and a single process both indexes and serves the read API — the tightest "how cleanly you wire them together" story.

**Trade-offs.** Ponder owns the database, so we live inside its schema and store rather than bringing our own ORM, and side-effects in the indexing path are replayed on reorg — acceptable here because we decrypt via the SDK's local `cleartext()` transport (a cheap, deterministic read), but on Sepolia a relayer round-trip would couple sync speed to relayer latency; that coupling is our documented least-confident-under-load risk, and the production fix is a decoupled, throttled decrypt worker. It is also pre-1.0 (0.16, an unfrozen API), mitigated by pinning the version and anchoring to current docs over memory.

**Alternatives considered.** Each was weighed against Ponder and rejected for one decisive reason:

- **viem + cursor loop** — would work, but the cost is manual wiring: we would hand-build sync, reorg, resume, _and_ the HTTP server that Ponder gives out of the box. Control we don't need, paid for by rebuilding plumbing on a 3–4h budget.
- **The Graph** — disqualified outright (not a lateral move): sandboxed subgraph mappings cannot make the network calls to the Zama relayer that decryption requires, and its auto-generated GraphQL undercuts the API design the brief explicitly grades.
- **Envio (HyperIndex)** — the closest peer: same TypeScript handler model, its own very fast sync layer (HyperSync), automatic reorg handling. But it has no extensible app server out of the box — it serves an auto-generated GraphQL API, so the bespoke partner REST endpoints would force us to wire in a second HTTP library alongside it and carry a GraphQL layer we never use.
- **Subsquid** — heavier still: a separate batch-processor service plus a TypeORM model and a generated GraphQL API. Same gap as Envio (bespoke REST means bolting on another server), with more moving parts than a one-process app warrants.

Ponder is the only option that bundles the indexing infrastructure _and_ an extensible Hono server in one process — it fits the task simply, with no extra libraries and no unused GraphQL overhead.

### 2. Chain & test environment: local fhEVM stack (over Sepolia)

**Decision.** Develop, test, and demo against a local fhEVM stack (Anvil + forge-fhevm) with the SDK's `cleartext()` transport, keeping the code chain-agnostic so the identical paths run on Sepolia via `node()` with one env change. The brief lets us pick whichever chain iterates fastest, and local wins on the axes that decide a graded POC: the chain is fresh and fully under our control, so tests deploy the contract and build a curated history (a shield, transfers, a delegation grant) deterministically and in advance; there is no faucet, so we fund EOAs and mint/transfer toy amounts inside the test setup itself; and there is no external dependency on a testnet RPC, faucet, relayer rate limits, or shared-chain timing. The decisive point is that `cleartext()` is not a mock: it drives the real high-level decrypt path and enforces real on-chain ACL (`persistAllowed` / `isAllowedForDecryption` / `isHandleDelegatedForUserDecryption`), so the pending → grant → backfill core — the heart of the task — is genuinely exercised, deterministically.

**Trade-offs.** Local does not exercise real FHE cryptography, ZK input proofs, or the hosted relayer/KMS round-trip, so we get no signal on relayer latency, throughput, 429s, or KMS availability — we accept this consciously, since it is precisely the under-load behaviour flagged as least-confident in Decision 1 and is Sepolia-only by nature, a deferred realism rather than a silent gap. The cost stays bounded because the swap is genuine, not cosmetic: the SDK forbids `cleartext()` on mainnet and Sepolia, so pointing at Sepolia necessarily switches to the real `node()` relayer path, which stays documented and one env var away for validating against the live network.

## What I composed vs. wrote myself

_The off-the-shelf primitives — indexing library (Ponder), the Zama SDK for decryption, the database, the HTTP server (Hono) — and why each was chosen. What was written by hand, and why._

_TODO_

## Key trade-offs

_Storage model, throttling against the relayer, and how the read API surfaces the awkward in-between states (amounts not yet decryptable). Where I would push back on the brief._

_TODO_

## Un-decryptable events & backfill

_How events the indexer cannot yet decrypt are persisted (encrypted handle + pending state) rather than dropped, and how cleartext is backfilled once an ACL delegation propagates._

_TODO_

## Reflection

### Least confident under partner load

_The one piece (a function, a callback, a chunk of the indexer config, an API handler) most likely to break first under load — what breaks, and how I would prove it._

_TODO_

### What I cut / the next four hours

_What was deliberately left out, and what I would do first with more time._

_TODO_

### SDK feedback

_Two or three concrete improvements to `@zama-fhe/sdk`. For each: (a) the concrete change, (b) the partner-integration scenario it unblocks, (c) its priority relative to the others._

1. **Export the contract ABIs (or add a `@zama-fhe/sdk/abi` entry).** The package ships event decoders (`decodeConfidentialTransfer`…), topic constants (`Topics`, `ACL_TOPICS`), and pure call-builders (`confidentialTransferContract`…) — 123 barrel exports — but **no consumable ABI array** for the ERC-7984 wrapper or the ACL contract (verified against the installed `3.1.0-alpha.15`: zero ABI-named exports, nothing under `dist/*abi*`, no `./abi` subpath). **(a) Change:** export `confidentialWrapperAbi` / `aclAbi` from the barrel or a `/abi` subpath — they already exist in-repo at `packages/sdk/src/abi/*.abi.ts` — and include the ACL delegation _events_, since the shipped `acl` ABI is functions-only. **(b) Unblocks:** wiring any ABI-driven indexer or tool — Ponder, a subgraph, viem `getContract`/`watchContract`, wagmi — against an ERC-7984 token; today you vendor the ABI out of the repo or hand-author event fragments (I had to hand-write the `DelegatedForUserDecryption` event ABI just to index delegations). That is step one of the exact "wallet partner builds an indexer" use case this SDK targets. **(c) Priority:** **high** — first blocker for backend/indexer integration, and near-free to fix since the ABIs already live in the repo.
2. **Give decrypt errors a retryability signal and a distinct "authorized-decryption denied" type.** The error _taxonomy_ is already strong — every error extends `ZamaError` with a machine-readable `code`, relayer failures carry a numeric `statusCode`, and `matchZamaError` ships as a code-keyed dispatcher (verified in `errors/base.ts`, `errors/relayer.ts`, `errors/decrypt.ts`), so an indexer can branch on types without scraping messages. The gap is one rung up — deciding _what to do_ with a failure. **(a) Change:** (i) expose the SDK's own transient detection — `isTransientError` (`relayer/relayer-utils.ts`) is internal today and is the SDK's _only_ message-regex; lifting it to a `retryable: boolean` on `ZamaError` (or an exported guard) lets callers reuse it instead of re-deriving it; (ii) split "no ACL / authorized-decryption denied" out of the generic 4xx `RelayerRequestFailedError` into its own code, and stop collapsing status-less transport failures into `DecryptionFailedError` whose `.message` is a generic fallback (the real cause is reachable only via `.cause`). **(b) Unblocks:** the exact pending-vs-failed decision this indexer makes on every undecryptable transfer — "park and wait for an ACL grant" vs "transient, retry on the next block sweep." Without the signal an integrator hand-rolls `classify(err)` and gets it subtly wrong: a status-less network blip wraps as `DecryptionFailedError` with a generic message, so a naive message-regex silently misfiles it as "not entitled" and the row never retries (a bug this project hit and fixed by switching to the typed `instanceof DecryptionFailedError`). **(c) Priority:** **medium** — the typed errors already make a correct classifier _possible_; this makes it _easy and uniform_ and removes the one place every backend integrator otherwise reinvents message-regex.
3. **Surface the local cleartext stack — clone-and-run is great DX, but you have to find it yourself.** forge-fhevm's local path is excellent: clone the repo and run `./deploy-local.sh` and the entire cleartext FHE host stack (Executor / ACL / InputVerifier / KMSVerifier) materialises on Anvil at canonical addresses with zero config; the SDK's own `contracts/` then adds a ready `Deploy.s.sol` that deploys the standard test tokens on top — together a turnkey, deterministic local test chain that needs no testnet, faucet, or relayer. **(a) Change:** surface this from the high-level `@zama-fhe/sdk` itself — a "local testing" quickstart (clone forge-fhevm → `deploy-local.sh` → point `cleartext()` at it), and ideally a thin SDK helper/CLI that wraps the clone+deploy so integrators don't shell out to a sibling repo. **(b) Unblocks:** the first hour of any backend/indexer integration — today you only discover `cleartext()`, forge-fhevm, and the canonical host addresses by reading SDK source and the `node-viem` example (which is Sepolia/`node()`-only), so the local, relayer-free path that actually makes this project testable is the least documented one. **(c) Priority:** **high for backend DX** — the difference between "works in an afternoon" and "reverse-engineer the test setup," and it compounds with feedback #1 (export the ABIs) to make the whole indexer story copy-pasteable. One doc-line caveat: `deploy-local.sh` deploys the FHE *host* stack only — your application token is still yours to deploy (the SDK's `contracts/Deploy.s.sol` is the perfect example to copy, which is exactly what this submission does).

### AI assistance

I built this with Claude Code (Claude Opus) as the primary tool, under one organising constraint: the alpha `@zama-fhe/sdk` postdates the model's training data, so the workflow is deliberately built to make it reason from a colocated source of truth instead of memory.

**Process.**

1. **Investigation before code.** The first pass was pure planning — comparing indexing primitives (Ponder over a hand-rolled viem loop or a subgraph), working out how the SDK actually performs user-decryption and ACL delegation, and weighing Sepolia against a local fhEVM stack. The output was the design doc and the Decision log above, not code.
2. **Colocated SDK source of truth.** Cloned `zama-ai/sdk` as a sibling of the project (`../sdk`) on the **`prerelease`** branch — the one that tracks the alpha — so the model reads real source and examples from disk (the `node-viem` example, the exported event decoders, `cleartext.ts`) rather than fetching stable docs that lag the alpha or inventing the API.
3. **Grounded project init.** Stood up a project `CLAUDE.md`, task-scoped skills (`ponder-indexer`, `zama-sdk`), and hooks, seeded from the brief (`TASK.md`, from the take-home email), the `sdk/` clone, and the Ponder scaffold — so every session opens with the domain rules and the never-edit-generated-files / never-generate-SDK-from-memory guardrails already loaded.
4. **PRD via superpowers.** Drove the model through the superpowers brainstorming → writing-plans pipeline to produce an in-depth design/PRD before touching implementation, instead of free-coding from a one-line prompt.

**One place it was subtly wrong.** The model's first instinct was to treat Zama's hosted relayer as the only way to decrypt and therefore to build on Sepolia — a framing still fossilised in `CLAUDE.md`, the README, and `.env.example`. It isn't obviously wrong; it produces a runnable plan. But it is subtly wrong in the two ways that matter most here: it would force the tests to mock the SDK (the testnet relayer is non-deterministic), so the happy-path and negative tests would no longer exercise the real decrypt path; and it misses the SDK's first-class `cleartext()` transport, which runs the identical high-level path locally while enforcing real on-chain ACL (the basis of Decision 2). Reading the SDK source — the correction the colocated clone in step 2 exists to force — surfaced `cleartext()` and flipped the plan to local-first, which is what makes the pending → grant → backfill seam testable deterministically against the real ACL instead of a mock. Reconciling the leftover Sepolia language in the older docs is on the build list.
