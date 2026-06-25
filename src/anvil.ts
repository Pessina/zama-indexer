// Local Anvil dev chain — the well-known Foundry accounts (#0–#3) and the local RPC.
// Public test keys derived from Foundry's default mnemonic ("test test … junk"),
// pre-funded at genesis — never real secrets. acct0 is the indexer's zero-config
// default holder (src/config.ts), the local deployer (`pnpm local:app`), and the
// tests' primary signer. The single home for both src and tests: neither viem nor
// @viem/anvil ships these private keys as constants (only a `mnemonic`/`accounts`
// option to generate them at runtime), so the canonical set is pinned here once.
import type { Hex } from "viem";

export const LOCAL_RPC = "http://127.0.0.1:8545";

export const ANVIL_KEYS = {
  acct0: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  acct1: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  acct2: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  acct3: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const satisfies Record<string, Hex>;
