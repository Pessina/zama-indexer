import type { Address } from "viem";
import { confidentialWrapperAbi } from "../../../abis/erc7984";
import { zama } from "../../zama-client";

// Re-export the single process-wide client (built once in src/zama-client.ts) so the read
// API and indexer share one definition; existing `{ zama, tokenMeta }` imports keep working.
export { zama };

// Token metadata is static — read once per token and memoise.
const metaCache = new Map<Address, { decimals: number; symbol: string }>();

export async function tokenMeta(token: Address): Promise<{ decimals: number; symbol: string }> {
  const cached = metaCache.get(token);
  if (cached) return cached;
  const [decimals, symbol] = await Promise.all([
    zama.publicClient.readContract({
      address: token,
      abi: confidentialWrapperAbi,
      functionName: "decimals",
    }),
    zama.publicClient.readContract({
      address: token,
      abi: confidentialWrapperAbi,
      functionName: "symbol",
    }),
  ]);
  const meta = { decimals: Number(decimals), symbol };
  metaCache.set(token, meta);
  return meta;
}
