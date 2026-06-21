// Anvil's well-known dev accounts (#0–#3). Public test keys, pre-funded with ETH at
// genesis — never real secrets. acct0 is the indexer's default holder (matches the
// PRIVATE_KEY default in src/lib/zama.ts and the deployer in `pnpm local:app`).
import { type Hex } from "viem";

export const ANVIL_KEYS = {
  acct0: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  acct1: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  acct2: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  acct3: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const satisfies Record<string, Hex>;
