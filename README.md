# zama-indexer

A confidential ERC-7984 indexer: it watches a single confidential-token contract on a local fhEVM stack, decrypts transfer amounts with the Zama SDK as events are indexed, and serves an ERC-20-style read API (cleartext balances, transfer history, indexer health). Partners call the API and never touch FHE.

## Prerequisites

- Node.js 22+ and pnpm
- [Foundry](https://getfoundry.sh) (`anvil`, `forge`, `cast`) — drives the local fhEVM stack

## The local stack & the `contracts/` folder

The indexer runs against a local **cleartext fhEVM** stack, so decryption is deterministic and needs no testnet or hosted relayer. Two pieces, kept deliberately separate:

- **`contracts/lib/forge-fhevm`** — Zama's [forge-fhevm](https://github.com/zama-ai/forge-fhevm), pinned as a git submodule. Its `deploy-local.sh` materialises the fhEVM **host stack** (Executor / ACL / InputVerifier / KMSVerifier) onto Anvil at canonical addresses, zero-config.
- **`contracts/`** — copied **verbatim** from the Zama SDK's reference deploy (the `contracts/` folder of [`zama-ai/sdk`](https://github.com/zama-ai/sdk), `prerelease`). Its `script/Deploy.s.sol` deploys the standard cleartext **test tokens** (cUSDC / cUSDT / cERC1363 + a wrappers registry) using the exact `ConfidentialWrapperV3` that is live on Sepolia/mainnet. The indexer watches **cUSDT**. It is left unmodified so it tracks Zama's reference 1:1 — to refresh it, re-copy `contracts/` from an SDK clone.

forge-fhevm deploys only the FHE host contracts; the application token is ours to deploy — hence both pieces.

## Setup

```bash
pnpm install
pnpm contracts:setup     # fetch the forge-fhevm submodule + Solidity deps, then build
```

## Run (local)

The stack is three processes — a chain, a one-time deploy, then the indexer + API — run in this order, in separate terminals:

```bash
pnpm chain               # terminal 1 — anvil (chain 31337); leave it running
pnpm local:deploy        # terminal 2 — deploy host stack + tokens → contracts/deployments.json (pre-wraps acct0 with 1000 cUSDT)
pnpm dev                 # terminal 3 — indexer + read API at http://localhost:42069
```

`chain` and `dev` are long-running servers; `local:deploy` is a one-shot that must land after the chain is up and before `dev`. Keep `chain` running across `dev` restarts, and re-run `pnpm local:deploy` to reset balances.

### Verify

```bash
# indexer sync status — last-indexed block per chain
curl -s localhost:42069/status

# cleartext balance for acct0 (the holder, pre-wrapped with 1000 cUSDT)
curl -s localhost:42069/v1/addresses/0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266/balance
```

To generate more activity to query — a P2P transfer, a `pending` row, and an ACL-delegation backfill — run the seed against the same chain: `pnpm dlx tsx scripts/seed.ts`.

## Configuration

Local runs need no `.env.local`: the indexer uses built-in defaults and auto-discovers the deployed token from `contracts/deployments.json`. Create `.env.local` only to override a default (see `.env.example` for every variable the service reads). Never commit a real key.

## Code quality

ESLint (Ponder's config contributes the type-aware `no-floating-promises`, and this project adds `await-thenable` — both matter here because a dropped or mis-awaited promise is a dropped decryption or DB write) covers correctness; Prettier covers formatting; `tsc` type-checks. The two don't overlap, so no `eslint-config-prettier` shim is needed.

```bash
pnpm typecheck    # tsc — strict, noUncheckedIndexedAccess on
pnpm lint         # eslint . --ext .ts   (pnpm lint:fix to autofix)
pnpm format       # prettier --write .   (pnpm format:check to verify, e.g. in CI)
```

## API

| Method | Path                               | Description                                                                                                                                                                                                                                                                       |
| ------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/v1/addresses/:address/transfers` | Transfer history (P2P confidential transfers + shields/unshields), cleartext where available. Per-row `status`, plus a single `delegationRequired` flag that signals whether a delegation is needed to reveal hidden amounts. Cursor-paginated: `cursor` / `limit` / `direction`. |
| GET    | `/v1/addresses/:address/balance`   | Current cleartext balance; `status:"indeterminate"` when the indexer lacks decrypt rights for the address.                                                                                                                                                                        |
| GET    | `/v1/health`                       | Indexer sync lag: `blocksBehind` = chain head − indexed checkpoint (`0` = caught up), with `chainId` / `indexedBlock` / `headBlock`. Always `200`; `503` only if the chain RPC is unreachable. Readiness/liveness stay at `/ready` · `/status`.                                   |
| GET    | `/docs` · `/openapi.json`          | Swagger UI + OpenAPI 3.1 — the contract that documents every status, the `delegationRequired` flag, and error code (incl. how to grant decrypt rights). Semantics live here, not in response prose.                                                                               |
| GET    | `/status` · `/ready`               | Raw indexer probes — Ponder's built-ins. `/status`: latest indexed block per chain (the checkpoint `/v1/health` reads). `/ready`: `200` once historical backfill completes — the still-syncing-vs-live signal `/v1/health` defers to rather than duplicates.                      |

## Testing

The tests are **integration tests** — they exercise the real SDK `cleartext()` decrypt path against a live local stack (anvil + the forge-fhevm host stack + the deployed token), with **no mocks**. `pnpm test` provisions that stack itself: it starts an ephemeral anvil, deploys the host stack + tokens, runs the suite, and tears anvil down — or reuses a chain you already have running. It needs [Foundry](https://getfoundry.sh) installed and the contracts built once:

```bash
pnpm contracts:setup     # once — fetch submodule + Solidity deps, then build
pnpm test                # spins up anvil + deploys + runs + tears the chain down
```

`test/` funds accounts in vitest hooks (mint → shield, then an ACL delegation, all via the SDK), then drives the indexer's decrypt seam (`src/utils/zama.ts`): the holder decrypts a handle it owns, a stranger's handle stays `pending` (never dropped), and an ACL delegation unlocks the backfill path. If you already have `pnpm chain` running, the suite reuses it — re-run `pnpm local:deploy` between runs to reset balances.

## Design

See `DECISIONS.md` for trade-offs and reflection.
