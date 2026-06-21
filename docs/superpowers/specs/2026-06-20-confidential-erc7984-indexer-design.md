# Confidential ERC-7984 Indexer — Design

Status: draft for review · Date: 2026-06-20 · Project: `zama-poc/`

## 1. Goal

Watch a single ERC-7984 confidential token (`ConfidentialWrapperV3`), decrypt the transfer amounts the indexer's holder is entitled to (as a transfer party or via ACL delegation) as events are indexed, persist the cleartext, and serve an ERC-20-style read API (balance, transfer history, health). Partners call cleartext endpoints and never touch FHE. Amounts the holder cannot yet decrypt are never dropped; cleartext is backfilled when rights are granted later.

## 2. Chain & runtime — local-first via the SDK's `cleartext()` transport (verified, not assumed)

**Decision:** develop, test, and demo on a **local fhEVM stack (Anvil + forge-fhevm)** using the SDK's first-class **`cleartext()`** relayer transport; keep all code chain-agnostic so the identical paths run on **Sepolia** via `node()` with one env change.

Why (verified against SDK source):

- Real FHE user-decryption requires Zama's hosted relayer+KMS (`node()`/`web()` → `relayer.{testnet,mainnet}.zama.org`). There is no self-hostable relayer/KMS in the clone.
- The SDK ships **`cleartext()`** (`sdk/packages/sdk/src/config/cleartext.ts`), a non-hosted transport that resolves `euint64` handles off-chain by reading forge-fhevm's on-chain TFHEExecutor `plaintexts(handle)` mapping while **enforcing real ACL on-chain** (`ACL.persistAllowed`, `ACL.isHandleDelegatedForUserDecryption`). It drives the _identical_ high-level API (`sdk.decryption.decryptValues`, `token.balanceOf`, delegated decrypt) and is hard-blocked on mainnet/sepolia (`FORBIDDEN_CHAIN_IDS`).
- So local gives: a **curated, reproducible dataset**; the **real SDK code path** (not a hand-rolled mock); **real ACL/delegation enforcement** (so the pending → grant → backfill core is genuinely exercised); and **deterministic tests against the real decrypt path**. Sepolia can match none of that (faucets, shared-testnet timing, relayer rate limits) and would force mocking the SDK in tests.
- What local does **not** cover: real FHE crypto, ZK input proofs, and relayer latency/throughput/429. Those are Sepolia-only and become the explicit "least confident under load" discussion (§10). Chain is a config swap (`cleartext()`+`hardhat` ⇄ `node()`+`sepolia`), so the real path is one env var away and documented.

## 3. Architecture

Four units, building on the existing Ponder scaffold in `zama-poc/`:

1. **Indexer** (`ponder.config.ts`, `src/index.ts`) — Ponder watches `ConfidentialWrapperV3` (+ the ACL contract for delegation events), decoding logs with the SDK's exported decoders (`decodeConfidentialTransfer`, `decodeWrapped`, `decodeUnwrap*`, `decodeDelegatedForUserDecryption`). Handlers persist on-chain facts and perform best-effort inline decryption.
2. **Decrypt seam** (`src/lib/zama.ts`) — one module that builds the `ZamaSDK` (chain-agnostic) and exposes `decryptAmount`, `decryptBalance`, `decryptBalanceAs`, with error mapping. The single place the SDK is touched; unit-testable against `cleartext()`.
3. **Read API** (`src/api/index.ts`, Hono) — cleartext endpoints + health.
4. **Local stack + seed** (`contracts/` + `scripts/seed`) — forge-fhevm contracts on Anvil and a seed script producing the curated dataset (shield → transfer → delegate → disclose), so a fresh clone reaches a running, populated indexer deterministically.

## 4. Data flow & decryption (matches the brief: "decrypted as events are indexed", "never silently dropped", "backfill")

- `ConfidentialTransfer(from,to,amount)` → persist a `transfer` row (amount = the `bytes32` `euint64` handle from `topics[3]`; kind = MINT if `from=0`, BURN if `to=0`, else TRANSFER). **Best-effort inline decrypt** via the seam:
  - entitled → `amountClear` + status `DECRYPTED`.
  - not entitled → status `PENDING` (handle kept; never dropped).
  - transient/relayer error → status `FAILED` (retried).
- Public amounts need no decryption: `Wrap.roundedAmount` (shield) and `UnwrapFinalized.cleartextAmount` (unshield) → status `PUBLIC`.
- **Backfill is event-driven** (Ponder-native):
  - `DelegatedForUserDecryption(delegator → our holder)` handler → re-decrypt that delegator's `PENDING` transfers, flip to `DECRYPTED`.
  - `AmountDisclosed(handle → plaintext)` handler → fill any `PENDING` transfer carrying that handle.
  - plus a light periodic retry for `FAILED` (Ponder block-interval handler or a small loop) covering transient relayer hiccups.
- Cleartext stays inside Ponder's tables (updated within the indexing pipeline, reorg-safe) — no external store/process for the submission. Decoupling into a throttled worker is the documented production evolution (§10).

(Ponder 0.16 specifics — cross-table `db.update` from a different event's handler, block-interval handlers — to confirm via the `ponder-indexer` skill / ponder.sh before coding.)

## 5. Data model (Ponder onchain tables)

- `transfer`: id (`txHash-logIndex`), fromAddr, toAddr, amountHandle (hex), amountClear (bigint?), status (enum), kind (MINT|BURN|TRANSFER), block, txHash, logIndex, timestamp, decryptedAt?.
- `wrap`: to, roundedAmount (bigint, public), encryptedHandle, block, tx…
- `unwrap`: receiver, requestId, amountHandle, cleartextAmount (bigint?, set at finalize), status, block…
- `delegation`: delegator, delegate, active, expiry, block.
- `account` (optional read-model): address, balanceHandle, balanceClear?, status, updatedBlock.
- Health/lag derived from Ponder's sync state (latest indexed vs chain head).

Status enum: `DECRYPTED` · `PUBLIC` · `PENDING` (entitlement may still arrive) · `FAILED` (transient; will retry). `NOT_ENTITLED` is folded into `PENDING` with a `reason` field, since rights can always arrive later — simpler, and matches the always-ready-to-backfill rule.

## 6. Read API (shapes are my design, per the brief)

- `GET /health` → `{ status, chainId, mode: "local"|"sepolia", indexedBlock, headBlock, blocksBehind, secondsBehind, decryption: { decrypted, public, pending, failed } }`.
- `GET /balances/:address` → `{ address, balance: string|null, status, handle, asOfBlock }` — balance via decrypting the live `confidentialBalanceOf` handle when entitled; else `balance: null`, `status: "PENDING"`, plus the handle.
- `GET /addresses/:address/transfers?cursor=&limit=&direction=` → `{ items: [{ id, direction: "in"|"out", counterparty, amount: string|null, status, kind, block, txHash, timestamp }], nextCursor }` — cleartext where available, status otherwise; rows are never omitted.
- Errors: JSON `{ error: { code, message } }`; codes `INVALID_ADDRESS` (400), `NOT_FOUND` (404), `INDEXER_BEHIND` (503 from health when lag exceeds a threshold). Pagination: opaque cursor over `(block, logIndex)`, stable ordering.

## 7. Testing (deterministic, against the real `cleartext()` path — no SDK mock needed)

- **Happy path (required):** seed a shield + transfer our holder is a party to → run indexing → assert `GET /addresses/:holder/transfers` returns the correct **cleartext** amount and `GET /balances/:holder` the correct balance. Proves event-in → cleartext-out through the API, exercising the real SDK decrypt path locally.
- **Negative (chosen):** a `ConfidentialTransfer` between two _other_ accounts (our holder is not a party and holds no delegation) → assert the row is persisted with `status: PENDING`, `amount: null` (never dropped), and the API surfaces it as pending. _Why this one:_ it validates the core domain rule — the brief's central seam — and proves real on-chain ACL (not a mock) is what gates decryption. Stretch (if time): grant a delegation → assert backfill flips it to `DECRYPTED`.

## 8. "Fresh clone → running" (setup story)

`pnpm install` → start Anvil → deploy forge-fhevm contracts (`forge script Deploy.s.sol`) → `pnpm seed` (curated dataset) → `pnpm dev` (index + API). To keep this turnkey, prefer a committed **Anvil state dump** (`anvil --dump-state`) of the deployed-and-seeded chain so graders without Foundry can `anvil --load-state` + `pnpm dev`; the `forge` deploy path stays documented for regeneration. (Final call at build: committed-state vs scripted-deploy — both reproducible; committed-state is lower friction.) README ships copy-paste commands.

## 9. Scope

**In:** indexer (transfer + wrap/unwrap + delegation events), inline decrypt + event-driven backfill, the three API endpoints, happy + negative tests, DECISIONS.md, README, `.env.example`.

**Cut (noted in DECISIONS.md):** decoupled throttled decrypt worker (production evolution), full two-phase unwrap UX, operator/blocklist events, rich reorg handling beyond Ponder defaults, multi-token/registry discovery (single token only).

## 10. Risks & least-confident-under-load

- **Inline decryption couples indexing to the relayer on Sepolia.** Locally (`cleartext()` = `eth_call`) it's fast; under real partner load on Sepolia the relayer round-trip + the SDK's _unhandled_ 429s + the per-contract concurrency cap (5) would make indexing stall behind decryption. This is the piece I'd trust least under load. How I'd prove it: point the seam at Sepolia (`node()`), replay N transfers, watch indexing lag and 429 rate climb; the fix is the decoupled throttled worker plus the SDK's per-handle clear-value cache. (Also the honest DECISIONS.md reflection.)
- **Local ≠ real crypto:** `cleartext()` validates integration + ACL/delegation, not FHE correctness / ZK proofs / relayer behavior — documented.
- **Ponder cross-handler updates / block-interval retries** to confirm against 0.16 before coding.

## 11. Env vars (→ `.env.example`)

`MODE` (local|sepolia) · `PONDER_RPC_URL_31337` / `PONDER_RPC_URL_11155111` · `SDK_RPC_URL` (Anvil or Sepolia) · `PRIVATE_KEY` (indexer holder/delegate EOA; toy) · `TOKEN_ADDRESS` · `ACL_ADDRESS` · `EXECUTOR_ADDRESS` (local) · `RELAYER_API_KEY` (Sepolia, optional) · `DATABASE_URL` (optional; SQLite fallback) · `START_BLOCK`.
