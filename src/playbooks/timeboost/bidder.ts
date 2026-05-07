/**
 * Phase 5a — Bidder.
 *
 * A bidder:
 *   1. ERC20.approve(auction, amount)
 *   2. auction.deposit(amount) — moves tokens from bidder to auction
 *   3. signs an EIP-712 Bid hash:
 *         Bid(uint64 round, address expressLaneController, uint256 amount)
 *      using the auction's `domainSeparator()` as the EIP-712 separator.
 *   4. POSTs the bid to the bid-validator's `auctioneer_submitBid` endpoint.
 *
 * Field layout MUST match nitro/timeboost/types.go:48-82 exactly. We hash the
 * struct ourselves (not via viem's `signTypedData`) because viem requires the
 * full TypedData domain object whereas the auction contract uses an opaque
 * domain separator we read directly from the chain.
 */

import {
  type Address,
  type Hash,
  type Hex,
  type LocalAccount,
  type PublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  pad,
  toBytes,
  toHex,
} from 'viem';
import { sign as signRawHash, signatureToHex, privateKeyToAccount } from 'viem/accounts';
import { erc20MinimalAbi, expressLaneAuctionArtifact } from './abis.js';
import { rawRpcCall, TimeboostRpcError } from './expressLaneRunner.js';

let log = {
  info: (m: string) => console.log('ℹ', m),
  warn: (m: string) => console.log('⚠', m),
  success: (m: string) => console.log('✔', m),
};

export function setBidderLogger(l: typeof log): void {
  log = l;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DepositInput {
  /** Private key of the bidder; we need raw key access to sign the bidHash without an EIP-191 prefix. */
  bidderPrivateKey: Hex;
  publicClient: PublicClient;
  auctionAddress: Address;
  biddingTokenAddress: Address;
  amount: bigint;
}

export interface SubmitBidInput {
  bidderPrivateKey: Hex;
  publicClient: PublicClient;
  auctionAddress: Address;
  bidValidatorUrl: string; // e.g. http://localhost:9372
  /** Round the bidder is bidding for (typically `currentRound + 1`). */
  round: bigint;
  /** Address that will get the express lane right if this bid wins. */
  expressLaneController: Address;
  /** Amount in wei of the bidding token. */
  amount: bigint;
}

export interface SubmittedBid {
  bidder: Address;
  round: bigint;
  amount: bigint;
  expressLaneController: Address;
  signature: Hex;
}

// ---------------------------------------------------------------------------
// Deposit
// ---------------------------------------------------------------------------

export async function approveAndDeposit(input: DepositInput): Promise<{ approveTx: Hash; depositTx: Hash }> {
  const { bidderPrivateKey, publicClient, auctionAddress, biddingTokenAddress, amount } = input;
  const bidder = privateKeyToAccount(bidderPrivateKey);

  log.info(`[${bidder.address}] approving ${amount} tokens for auction ${auctionAddress}...`);
  const approveTx = await sendCall(
    publicClient,
    bidder,
    biddingTokenAddress,
    encodeFunctionData({
      abi: erc20MinimalAbi,
      functionName: 'approve',
      args: [auctionAddress, amount],
    }),
  );

  log.info(`[${bidder.address}] depositing ${amount} into auction...`);
  const depositTx = await sendCall(
    publicClient,
    bidder,
    auctionAddress,
    (encodeFunctionData as unknown as (a: unknown) => Hex)({
      abi: expressLaneAuctionArtifact.abi,
      functionName: 'deposit',
      args: [amount],
    }),
  );

  log.success(`[${bidder.address}] deposit confirmed`);
  return { approveTx, depositTx };
}

// ---------------------------------------------------------------------------
// Bid signing & submission
// ---------------------------------------------------------------------------

export async function readDomainSeparator(publicClient: PublicClient, auctionAddress: Address): Promise<Hex> {
  const result = (await publicClient.readContract({
    address: auctionAddress,
    abi: expressLaneAuctionArtifact.abi,
    functionName: 'domainSeparator',
  })) as Hex;
  return result;
}

/**
 * Build the EIP-712 hash that the bidder must sign. Mirrors
 * nitro/timeboost/types.go:48-82:
 *
 *   typeHash = keccak256("Bid(uint64 round,address expressLaneController,uint256 amount)")
 *   structHash = keccak256(abi.encode(typeHash, round, controller, amount))
 *   bidHash = keccak256("\x19\x01" || domainSeparator || structHash)
 */
export function bidHash(input: {
  domainSeparator: Hex;
  round: bigint;
  expressLaneController: Address;
  amount: bigint;
}): Hex {
  const typeHash = keccak256(toBytes('Bid(uint64 round,address expressLaneController,uint256 amount)'));

  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint64' }, // round
        { type: 'address' },
        { type: 'uint256' },
      ],
      [typeHash, input.round, input.expressLaneController, input.amount],
    ),
  );

  // 0x1901 || domainSeparator(32) || structHash(32)
  const prefix = '0x1901' as const;
  const concat = (prefix + input.domainSeparator.slice(2) + structHash.slice(2)) as Hex;
  return keccak256(concat);
}

export async function signBid(
  bidderPrivateKey: Hex,
  input: { domainSeparator: Hex; round: bigint; expressLaneController: Address; amount: bigint },
): Promise<Hex> {
  const hash = bidHash(input);
  // Sign the raw 32-byte digest with no EIP-191 prefix — Nitro's bid validator
  // does an `ecrecover` directly over `bidHash` (timeboost/bid_validator.go:384
  // calls ToEIP712Hash then crypto.SigToPub on the result, no "Ethereum Signed
  // Message:" prefix).
  const sig = await signRawHash({ hash, privateKey: bidderPrivateKey });
  return signatureToHex(sig);
}

export async function submitBid(input: SubmitBidInput): Promise<SubmittedBid> {
  const bidder = privateKeyToAccount(input.bidderPrivateKey);
  const domainSeparator = await readDomainSeparator(input.publicClient, input.auctionAddress);

  const signature = await signBid(input.bidderPrivateKey, {
    domainSeparator,
    round: input.round,
    expressLaneController: input.expressLaneController,
    amount: input.amount,
  });

  const chainId = await input.publicClient.getChainId();

  const payload = {
    chainId: toHex(chainId),
    expressLaneController: input.expressLaneController,
    auctionContractAddress: input.auctionAddress,
    round: toHex(input.round),
    amount: toHex(input.amount),
    signature,
  };

  log.info(
    `[${bidder.address}] submitting bid: round=${input.round} amount=${input.amount} controller=${input.expressLaneController}`,
  );

  try {
    await rawRpcCall(input.bidValidatorUrl, 'auctioneer_submitBid', [payload]);
    log.success(`[${bidder.address}] bid accepted by validator`);
  } catch (e) {
    if (e instanceof TimeboostRpcError) {
      log.warn(`bid rejected by validator: ${e.rpcMessage}`);
    }
    throw e;
  }

  return {
    bidder: bidder.address,
    round: input.round,
    amount: input.amount,
    expressLaneController: input.expressLaneController,
    signature,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function sendCall(
  publicClient: PublicClient,
  signer: LocalAccount<string>,
  to: Address,
  data: Hex,
): Promise<Hash> {
  const nonce = await publicClient.getTransactionCount({ address: signer.address, blockTag: 'pending' });
  const gasPrice = await publicClient.getGasPrice();
  const chainId = await publicClient.getChainId();

  const signed = (await signer.signTransaction({
    chainId,
    type: 'eip1559',
    to,
    value: 0n,
    data,
    gas: 500_000n,
    maxFeePerGas: gasPrice * 2n,
    maxPriorityFeePerGas: gasPrice,
    nonce,
  })) as Hex;

  const txHash = await publicClient.sendRawTransaction({ serializedTransaction: signed });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') throw new Error(`Tx ${txHash} reverted`);
  return txHash;
}

// Suppress unused-import warning for `pad` — exported as part of viem's API
// surface that we may need in tests.
void pad;
