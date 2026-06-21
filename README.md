# zama-indexer

A confidential ERC-7984 indexer: it watches a single confidential-token contract on Sepolia, decrypts transfer amounts with the Zama SDK as events are indexed, and serves an ERC-20-style read API (cleartext balances, transfer history, indexer health). Partners call the API and never touch FHE.

> Draft — setup is runnable; the API and architecture sections are stubbed. See `DECISIONS.md` for design notes.

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

```bash
pnpm chain               # terminal 1 — anvil (chain 31337); keep it running
pnpm local:deploy        # terminal 2 — host stack + tokens; writes addresses into .env.local
pnpm dev                 # indexer + read API at http://localhost:42069
```

## Configuration

`pnpm local:deploy` writes a ready-to-run `.env.local` for local mode. See `.env.example` for every variable the service reads (including the Sepolia variables for `MODE=sepolia`). Never commit a real key.

## Code quality

ESLint (Ponder's config — its one rule is the type-aware `no-floating-promises`, which matters here because a dropped promise is a dropped decryption or DB write) covers correctness; Prettier covers formatting; `tsc` type-checks. The two don't overlap, so no `eslint-config-prettier` shim is needed.

```bash
pnpm typecheck    # tsc — strict, noUncheckedIndexedAccess on
pnpm lint         # eslint . --ext .ts   (pnpm lint:fix to autofix)
pnpm format       # prettier --write .   (pnpm format:check to verify, e.g. in CI)
```

## API

| Method | Path   | Description                                                 |
| ------ | ------ | ----------------------------------------------------------- |
| GET    | _TODO_ | Current cleartext balance for an address                    |
| GET    | _TODO_ | Transfer history for an address (cleartext where available) |
| GET    | _TODO_ | Indexer health and how far behind it is                     |

## Testing

The tests are **integration tests** — they exercise the real SDK `cleartext()` decrypt path against a live local stack (anvil + the forge-fhevm host stack + the deployed token), with **no mocks**. They need [Foundry](https://getfoundry.sh) and the stack running:

```bash
pnpm contracts:setup     # once — fetch submodule + Solidity deps, then build
pnpm chain               # terminal 1 — anvil (chain 31337); keep it running
pnpm local:deploy        # terminal 2 — host stack + tokens; writes .env.local
pnpm test                # terminal 2 — vitest run
```

`test/` funds accounts in vitest hooks (mint → shield → transfer/delegate via the SDK), then drives the indexer's decrypt seam (`src/lib/zama.ts`): the holder decrypts a handle it owns, a stranger's handle stays `pending` (never dropped), and an ACL delegation unlocks the backfill path. Assertions assume a freshly-deployed stack, so re-run `pnpm local:deploy` between runs (confidential balances accumulate on a persistent chain).

## Design

See `DECISIONS.md` for trade-offs and reflection.
