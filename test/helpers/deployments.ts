// Resolve the locally-deployed token addresses written by `pnpm local:deploy`
// (`contracts/deployments.json`). The indexer watches cUSDT; tests fund and assert
// against the same token. Read at runtime (not imported) so tsc need not include
// the excluded `contracts/` tree.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Address } from "viem";

export interface Deployments {
  erc20: Address;
  cToken: Address;
  USDT: Address;
  cUSDT: Address;
  ERC1363: Address;
  cERC1363: Address;
  wrappersRegistry: Address;
}

export function loadDeployments(root: string = process.cwd()): Deployments {
  const path = resolve(root, "contracts", "deployments.json");
  return JSON.parse(readFileSync(path, "utf8")) as Deployments;
}
