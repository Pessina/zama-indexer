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

### 2. Chain & test environment: local-only fhEVM stack (Anvil + forge-fhevm)

**Decision.** Target a local fhEVM stack exclusively (Anvil + forge-fhevm) with the SDK's `cleartext()` transport. The brief lets us pick whichever chain iterates fastest, and local wins on the axes that decide a graded POC: the chain is fresh and fully under our control, so tests deploy the contract and build a curated history (a shield, transfers, a delegation grant) deterministically and in advance; there is no faucet, so we fund EOAs and mint/transfer toy amounts inside the test setup itself; and there is no external dependency on a testnet RPC, faucet, relayer rate limits, or shared-chain timing. The decisive point is that `cleartext()` is not a mock: it drives the real high-level decrypt path and enforces real on-chain ACL (`persistAllowed` / `isAllowedForDecryption` / `isHandleDelegatedForUserDecryption`), so the pending → grant → backfill core — the heart of the task — is genuinely exercised, deterministically.

**Trade-offs.** Local does not exercise real FHE cryptography, ZK input proofs, or the hosted relayer/KMS round-trip, so we get no signal on relayer latency, throughput, 429s, or KMS availability — the under-load behaviour flagged as least-confident in Decision 1. We removed the Sepolia (`node()`) transport entirely rather than ship it behind a `MODE` flag we never ran: a dual-mode seam carried an unverified "one env var away" claim and, worse, an unavoidable ambiguity in error classification — the SDK's `DecryptionFailedError` means "not entitled" on `cleartext()` but "transient transport failure" on `node()`, so a single transport-agnostic `classify` cannot be correct for both. Going local-only makes the seam honest and unambiguous; the relayer-path realities (latency, 429s, reorg-replayed decrypts, KMS availability) and the decoupled decrypt-worker that would absorb them are documented as deferred production work (Decision 1), not pretended-at in code.

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

The seam that got the most scrutiny this round was decrypt error handling, but its correctness _verification_ was deliberately time-boxed. What shipped: `ZamaClient.classify()` now routes on the SDK's machine-readable `ZamaError.code` via `matchZamaError` instead of `instanceof` + message cascades — fatal misconfiguration codes (`CHAIN_MISMATCH`, `SIGNER_NOT_CONFIGURED`, `CONFIGURATION`) rethrow so a deploy-time mistake fails loud; the unknown-error default flipped from a silent `pending` to `failed` (so a misclassified row is sweep-retried and honestly labelled, not parked looking like "awaiting authorization"); and the relayer-only codes (`DELEGATION_NOT_PROPAGATED`, `RELAYER_REQUEST_FAILED`, `NO_CIPHERTEXT`) are mapped forward-looking. What was delayed, in priority order:

1. **In-depth false-positive / false-negative audit of the not-entitled classification — the piece I trust least under load.** The one decrypt outcome the SDK gives no code for is "not entitled": on the `cleartext()` transport it surfaces as a generic `DecryptionFailedError` whose only signal is the message text, so the pending-vs-failed decision rests on a regex (`/not authorized|not delegated|not allowed/i`) coupled to SDK-internal string literals (`relayer-cleartext.ts` `#assertDecryptAuthorization` / `#assertDelegation`). The two hazards are asymmetric and both currently latent: a **false negative** — a genuinely not-entitled handle mis-read as `failed` — is retried only as a _direct_ decrypt (which fails deterministically), capped at `MAX_ATTEMPTS`, then stranded _and_ invisible to grant-backfill (which scans `status = 'pending'`), i.e. permanent cleartext loss; a **false positive** — a transient error mis-read as `pending` — is retried only when an ACL grant lands, which for a non-delegation error never comes. Today both are bounded but not _eliminated_, and the only evidence the regex still matches reality is the single "stranger → pending" integration test acting as a canary. The deferred rigor: (a) a property/mutation test of `classify()` over every SDK decrypt throw site, including reworded-message mutations that must make the canary fail (proving it actually guards the coupling); and (b) the relayer-path classification — 429/5xx, KMS latency, the delegation-propagation race — which the local-only `cleartext()` stack cannot fire at all, so it is entirely unexercised.
2. **Make retry eligibility key off the data invariant, not the status label — the change that makes (1) stop mattering.** The stranding in (1) exists only because the label gates which retry path a row gets: `RetryDecryptions:block` retries `status = 'failed'` rows via the direct path (no delegator), and the `DelegatedForUserDecryption` backfill retries `status = 'pending'` rows only — so a misclassification decides whether a row is _ever_ retrievable. The fix is to drive both triggers off `amountClear IS NULL`: the sweep consults the `delegation` table and retries via the _delegated_ path when a row's `from`/`to` has an active delegation, and the backfill scans `amountClear IS NULL` touching the delegator rather than `status = 'pending'`. Then classification degrades to an advisory DX/throttling hint that can be wrong without losing data.
3. **Never silently give up at `MAX_ATTEMPTS`.** A `failed` row that exhausts its five sweep retries drops out of the sweep query forever — indistinguishable, from the API's side, from "still trying." Either retry forever with a decaying cadence, or promote exhausted rows to an explicit terminal state surfaced on the health endpoint for operator re-trigger; "capped and forgotten" violates the brief's never-silently-drop rule.
4. **(Larger, separate cut.)** The biggest functional omission is the partner-facing read API itself (cleartext balance, transfer history, health/lag — `src/api/` is still only Ponder's default GraphQL/SQL passthrough) and the brief's end-to-end "event in → cleartext out of the API" happy-path test (the current tests stop at the decrypt seam). That belongs to its own reflection; with another four hours it comes before any further error-handling polish.

### SDK feedback

_Two or three concrete improvements to `@zama-fhe/sdk`. For each: (a) the concrete change, (b) the partner-integration scenario it unblocks, (c) its priority relative to the others._

Credit before the asks (this is a design-review note, not a grievance list): the typed-error layer is a genuinely good addition. Every SDK error extends `ZamaError` with a stable, machine-readable `.code` (the `ZamaErrorCode` enum) and `matchZamaError` ships as a code-keyed dispatcher (verified against the installed `3.1.0-alpha.15`; source in `errors/base.ts`). The payoff is concrete: after I routed the decrypt seam through `.code`, every failure the SDK assigns a code to is handled by branching on that code with **zero string matching** — exactly the contract a backend integrator wants, and a real step up from sniffing `.message`. That strength is what makes the one exception worth flagging in #2: the single decrypt outcome with _no_ code — ACL "not entitled" — is the one this indexer leans on most, so it stays the lone place we're forced back to matching message strings.

1. **Export the contract ABIs (or add a `@zama-fhe/sdk/abi` entry).** The package ships event decoders (`decodeConfidentialTransfer`…), topic constants (`Topics`, `ACL_TOPICS`), and pure call-builders (`confidentialTransferContract`…) — 123 barrel exports — but **no consumable ABI array** for the ERC-7984 wrapper or the ACL contract (verified against the installed `3.1.0-alpha.15`: zero ABI-named exports, nothing under `dist/*abi*`, no `./abi` subpath). **(a) Change:** export `confidentialWrapperAbi` / `aclAbi` from the barrel or a `/abi` subpath — they already exist in-repo at `packages/sdk/src/abi/*.abi.ts` — and include the ACL delegation _events_, since the shipped `acl` ABI is functions-only. **(b) Unblocks:** wiring any ABI-driven indexer or tool — Ponder, a subgraph, viem `getContract`/`watchContract`, wagmi — against an ERC-7984 token; today you vendor the ABI out of the repo or hand-author event fragments (I had to hand-write the `DelegatedForUserDecryption` event ABI just to index delegations). That is step one of the exact "wallet partner builds an indexer" use case this SDK targets. **(c) Priority:** **high** — first blocker for backend/indexer integration, and near-free to fix since the ABIs already live in the repo.
2. **Give decrypt errors a retryability signal and a distinct "authorized-decryption denied" type.** The codes credited above tell you _what_ failed; the gap is one rung up — deciding _what to do_ about it — which is exactly the decision this indexer makes on every undecryptable transfer. Two signals are missing, and both bite here. **(a) Change:** (i) expose the SDK's own transient detection — `isTransientError` (`relayer/relayer-utils.ts`) is internal today and is the SDK's _only_ message-regex; lifting it to a `retryable: boolean` on `ZamaError` (or an exported guard) lets callers reuse it instead of re-deriving it; (ii) split "no ACL / authorized-decryption denied" out of the generic 4xx `RelayerRequestFailedError` into its own code, and stop collapsing status-less transport failures into `DecryptionFailedError` whose `.message` is a generic fallback (the real cause is reachable only via `.cause`). **(b) Unblocks:** the exact pending-vs-failed decision this indexer makes on every undecryptable transfer — "park and wait for an ACL grant" vs "transient, retry on the next block sweep." Without the signal an integrator hand-rolls `classify(err)` and gets it subtly wrong: on the `cleartext()` transport the not-entitled `DecryptionFailedError` is separable from a genuine transport failure only by its message text, so the pending-vs-failed call hinges on a brittle `err.message` regex (this project's `src/utils/zama.ts` does exactly that — and it breaks the day the SDK rewords a string). **(c) Priority:** **medium** — the typed errors already make a correct classifier _possible_; this makes it _easy and uniform_ and removes the one place every backend integrator otherwise reinvents message-regex.
3. **Surface the local cleartext stack — clone-and-run is great DX, but you have to find it yourself.** forge-fhevm's local path is excellent: clone the repo and run `./deploy-local.sh` and the entire cleartext FHE host stack (Executor / ACL / InputVerifier / KMSVerifier) materialises on Anvil at canonical addresses with zero config; the SDK's own `contracts/` then adds a ready `Deploy.s.sol` that deploys the standard test tokens on top — together a turnkey, deterministic local test chain that needs no testnet, faucet, or relayer. **(a) Change:** surface this from the high-level `@zama-fhe/sdk` itself — a "local testing" quickstart (clone forge-fhevm → `deploy-local.sh` → point `cleartext()` at it), and ideally a thin SDK helper/CLI that wraps the clone+deploy so integrators don't shell out to a sibling repo. **(b) Unblocks:** the first hour of any backend/indexer integration — today you only discover `cleartext()`, forge-fhevm, and the canonical host addresses by reading SDK source and the `node-viem` example (which is Sepolia/`node()`-only), so the local, relayer-free path that actually makes this project testable is the least documented one. **(c) Priority:** **high for backend DX** — the difference between "works in an afternoon" and "reverse-engineer the test setup," and it compounds with feedback #1 (export the ABIs) to make the whole indexer story copy-pasteable. One doc-line caveat: `deploy-local.sh` deploys the FHE _host_ stack only — your application token is still yours to deploy (the SDK's `contracts/Deploy.s.sol` is the perfect example to copy, which is exactly what this submission does).

### AI assistance

I built this with Claude Code (Claude Opus) as the primary tool, under one organising constraint: the alpha `@zama-fhe/sdk` postdates the model's training data, so the workflow is deliberately built to make it reason from a colocated source of truth instead of memory.

**Process.**

1. **Investigation before code.** The first pass was pure planning — comparing indexing primitives (Ponder over a hand-rolled viem loop or a subgraph), working out how the SDK actually performs user-decryption and ACL delegation, and weighing Sepolia against a local fhEVM stack. The output was the design doc and the Decision log above, not code.
2. **Colocated SDK source of truth.** Cloned `zama-ai/sdk` as a sibling of the project (`../sdk`) on the **`prerelease`** branch — the one that tracks the alpha — so the model reads real source and examples from disk (the `node-viem` example, the exported event decoders, `cleartext.ts`) rather than fetching stable docs that lag the alpha or inventing the API.
3. **Grounded project init.** Stood up a project `CLAUDE.md`, task-scoped skills (`ponder-indexer`, `zama-sdk`), and hooks, seeded from the brief (`TASK.md`, from the take-home email), the `sdk/` clone, and the Ponder scaffold — so every session opens with the domain rules and the never-edit-generated-files / never-generate-SDK-from-memory guardrails already loaded.
4. **PRD via superpowers.** Drove the model through the superpowers brainstorming → writing-plans pipeline to produce an in-depth design/PRD before touching implementation, instead of free-coding from a one-line prompt.
