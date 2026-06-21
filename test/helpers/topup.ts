// Fund accounts entirely from test setup (vitest hooks), through the SDK's real
// `cleartext()` path — no forge script, no demo seed. Each primitive builds a
// short-lived signer and tears it down, so a `beforeAll` composes exactly the
// dataset it asserts on. ERC-7984 transfers clamp to 0 on insufficient balance
// (the amount is encrypted, so they cannot revert), so always `mintAndShield`
// enough before transferring.
import { type Address, type Hex } from "viem";
import { makeSigner } from "./local-sdk";

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

/** Mint `amount` of the wrapper's underlying ERC-20 to the signer, then shield it into a confidential balance. */
export async function mintAndShield(
  pk: Hex,
  params: { confidentialToken: Address; amount: bigint },
): Promise<void> {
  const { account, publicClient, walletClient, sdk } = makeSigner(pk);
  try {
    const wrapped = sdk.createWrappedToken(params.confidentialToken);
    const underlying = await wrapped.underlying();
    const hash = await walletClient.writeContract({
      address: underlying,
      abi: MINT_ABI,
      functionName: "mint",
      args: [account.address, params.amount],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    await wrapped.shield(params.amount); // approve + wrap, to self
  } finally {
    await sdk.terminate();
  }
}

/** Send a confidential transfer from the signer to `to`. */
export async function confidentialTransfer(
  pk: Hex,
  params: { confidentialToken: Address; to: Address; amount: bigint },
): Promise<void> {
  const { sdk } = makeSigner(pk);
  try {
    await sdk.createToken(params.confidentialToken).confidentialTransfer(params.to, params.amount);
  } finally {
    await sdk.terminate();
  }
}

/** Grant decrypt rights on `confidentialToken` from the signer to `delegate` (drives backfill). */
export async function delegateDecryption(
  pk: Hex,
  params: { confidentialToken: Address; delegate: Address },
): Promise<void> {
  const { sdk } = makeSigner(pk);
  try {
    await sdk.delegations.delegateDecryption({
      contractAddress: params.confidentialToken,
      delegateAddress: params.delegate,
    });
  } finally {
    await sdk.terminate();
  }
}
