// Test-only: build a ZamaSDK + viem clients bound to one signer against the local
// cleartext stack. Mirrors the SDK's node-viem example — the `cleartext()` transport
// over Anvil + forge-fhevm — so the real high-level decrypt path runs locally with no
// hosted relayer. This is the same wiring the indexer uses in `src/lib/zama.ts`, but
// per-signer (tests act as several accounts) rather than a single-holder singleton.
import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { MemoryStorage, ZamaSDK } from "@zama-fhe/sdk";
import { hardhat } from "@zama-fhe/sdk/chains";
import { createConfig } from "@zama-fhe/sdk/viem";
import { cleartext } from "@zama-fhe/sdk/node";

export const LOCAL_RPC = process.env.SDK_RPC_URL ?? "http://127.0.0.1:8545";

/** A signer-bound bundle: the viem account/clients plus a ZamaSDK using the cleartext transport. */
export function makeSigner(pk: Hex, rpc: string = LOCAL_RPC) {
  const account = privateKeyToAccount(pk);
  const transport = http(rpc);
  const publicClient = createPublicClient({ chain: foundry, transport });
  const walletClient = createWalletClient({ account, chain: foundry, transport });
  const sdk = new ZamaSDK(
    createConfig({
      chains: [{ ...hardhat, network: rpc }],
      publicClient,
      walletClient,
      storage: new MemoryStorage(),
      relayers: { [hardhat.id]: cleartext() },
    }),
  );
  return { account, publicClient, walletClient, sdk };
}
