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

## Testing

Two lanes:

- **`pnpm test:unit`** — fast, Foundry-free unit tests (`test/unit/`) over the pure pieces: the decrypt-error classifier (`classifyDecryptError`), the cursor codec, RFC 9457 problem rendering + address parsing, and transfer-row → API-item mapping. No chain, no anvil — the TDD loop and a CI lane that needs no Foundry.
- **`pnpm test`** — the full suite, those unit tests included. Its **end-to-end tests** (`test/*.e2e.test.ts`) are integration tests: they exercise the real SDK `cleartext()` decrypt path against a live local stack (anvil + the forge-fhevm host stack + the deployed token), with **no mocks**. `pnpm test` provisions that stack itself — it starts its own ephemeral anvil on `8545`, deploys the host stack + tokens, runs the suite, and tears the chain down. It needs [Foundry](https://getfoundry.sh) installed and the contracts built once.

```bash
pnpm contracts:setup     # once — fetch submodule + Solidity deps, then build
pnpm test                # ephemeral anvil → deploy → full suite → tear the chain down
pnpm test:unit           # just the pure unit tests — no anvil, no Foundry
```

## Design

See `DECISIONS.md` for trade-offs and reflection.
