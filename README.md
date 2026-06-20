# zama-indexer

A confidential ERC-7984 indexer: it watches a single confidential-token contract on Sepolia, decrypts transfer amounts with the Zama SDK as events are indexed, and serves an ERC-20-style read API (cleartext balances, transfer history, indexer health). Partners call the API and never touch FHE.

> Draft — setup is runnable; the API and architecture sections are stubbed. See `DECISIONS.md` for design notes.

## Prerequisites

- Node.js 22+
- pnpm
- A Sepolia RPC endpoint and a funded test EOA (toy keys only)

## Setup

```bash
pnpm install
pnpm add @zama-fhe/sdk@alpha   # not yet a dependency
cp .env.example .env.local     # then fill in the values
```

## Configuration

See `.env.example` for every variable the service reads. Never commit a real key.

## Run

```bash
pnpm dev      # indexer + read API, with hot reload
```

_TODO: default port; endpoint list._

## API

| Method | Path     | Description                                                  |
| ------ | -------- | ----------------------------------------------------------- |
| GET    | _TODO_   | Current cleartext balance for an address                    |
| GET    | _TODO_   | Transfer history for an address (cleartext where available) |
| GET    | _TODO_   | Indexer health and how far behind it is                     |

## Testing

```bash
pnpm test     # TODO: add a test runner (e.g. vitest)
```

_Happy path: an event going in produces correct cleartext out of the API. Plus one negative test._

## Design

See `DECISIONS.md` for trade-offs and reflection.
