import { type Address, type Hex } from "viem";
import { ZamaClient } from "../../src/utils/zama";
import { LOCAL_RPC } from "../../src/anvil";

// Minimal ABI for the TestERC20 mock's open `mint` (test tokens only).
const MINT_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export class TestActor {
  readonly client: ZamaClient;

  constructor(pk: Hex, rpc: string = LOCAL_RPC) {
    this.client = new ZamaClient({ privateKey: pk, rpc });
  }

  get address(): Address {
    return this.client.account.address;
  }

  /** Mint the wrapper's underlying ERC-20 to this actor, then shield it into a confidential balance. */
  async mintAndShield(confidentialToken: Address, amount: bigint): Promise<void> {
    const wrapped = this.client.sdk.createWrappedToken(confidentialToken);
    const underlying = await wrapped.underlying();
    const hash = await this.client.walletClient.writeContract({
      address: underlying,
      abi: MINT_ABI,
      functionName: "mint",
      args: [this.address, amount],
    });
    await this.client.publicClient.waitForTransactionReceipt({ hash });
    await wrapped.shield(amount); // approve + wrap, to self
  }

  /** Send a confidential transfer from this actor to `to`. */
  async confidentialTransfer(
    confidentialToken: Address,
    to: Address,
    amount: bigint,
  ): Promise<void> {
    await this.client.sdk.createToken(confidentialToken).confidentialTransfer(to, amount);
  }

  /** Grant decrypt rights on `confidentialToken` from this actor to `delegate` (drives backfill). */
  async delegateDecryption(confidentialToken: Address, delegate: Address): Promise<void> {
    await this.client.sdk.delegations.delegateDecryption({
      contractAddress: confidentialToken,
      delegateAddress: delegate,
    });
  }

  terminate(): void {
    this.client.terminate();
  }
}
