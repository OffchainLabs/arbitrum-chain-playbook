/**
 * Submit an express-lane transaction via Nitro's `timeboost_sendExpressLaneTransaction`
 * JSON-RPC method (see nitro/execution/gethexec/api.go:86).
 *
 * Two outputs we care about for the demo:
 *   1. The L2 tx hash (so we can later read the receipt and inspect `timeboosted`).
 *   2. The wall-clock timestamp at which we submitted it (for the timeline plot).
 */

import {
  type Address,
  type Hash,
  type Hex,
  type LocalAccount,
  type PublicClient,
  keccak256,
  parseEther,
  toHex,
} from 'viem';
import { DONT_CARE_SEQUENCE, type JsonExpressLaneSubmission, type TxObservation } from './types.js';
import { signExpressLaneSubmission } from './expressLaneSigner.js';

/**
 * Minimal logger surface so Phase 6 modules don't have to import the
 * playbook-wide logger.ts (which transitively pulls in `ora` →
 * `cli-spinners` and breaks on Node < 20.10 due to import attributes).
 *
 * Default is a `console.log`-backed no-op-ish sink. Production callers can
 * pass the real logger via `setRunnerLogger()`.
 */
export interface RunnerLogger {
  event: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

let activeLogger: RunnerLogger = {
  event: (m) => console.log('•', m),
  info: (m) => console.log('ℹ', m),
  warn: (m) => console.log('⚠', m),
};

export function setRunnerLogger(l: RunnerLogger): void {
  activeLogger = l;
}

export interface ExpressLaneSubmitInput {
  /** Controller account (must be a LocalAccount<string>; needs to deterministically sign tx + envelope). */
  controllerAccount: LocalAccount<string>;
  /** Public client connected to the child chain — used for nonce / gasPrice lookup. */
  childClient: PublicClient;
  chainId: number;
  round: bigint;
  /** ExpressLaneAuction proxy address. */
  auctionContractAddress: Address;
  /** sequencer HTTP RPC endpoint that exposes the `timeboost` API namespace. */
  sequencerRpcUrl: string;
  /** Recipient + value of the underlying L2 tx (kept trivial for the demo). */
  to: Address;
  valueEth?: string;
  /**
   * Optional override; defaults to DontCareSequence (2^64-1) which bypasses the
   * per-round reordering queue. See nitro/timeboost/express_lane_service.go:78.
   */
  sequenceNumber?: bigint;
  /** Tag printed in logs to distinguish multiple parallel submissions. */
  label?: string;
}

export interface ExpressLaneSubmitResult {
  txHash: Hash;
  sentAtMs: number;
  rlpTx: Hex;
  submission: JsonExpressLaneSubmission;
}

/**
 * Sign + wrap + POST. The function returns as soon as the sequencer accepts the
 * submission; the caller is responsible for polling the receipt afterwards.
 */
export async function submitExpressLaneTransaction(input: ExpressLaneSubmitInput): Promise<ExpressLaneSubmitResult> {
  const {
    controllerAccount,
    childClient,
    chainId,
    round,
    auctionContractAddress,
    sequencerRpcUrl,
    to,
    valueEth = '0',
    sequenceNumber = DONT_CARE_SEQUENCE,
    label = 'express',
  } = input;

  // 1. Read the controller's pending nonce + current gas price for a clean tx envelope.
  const nonce = await childClient.getTransactionCount({
    address: controllerAccount.address,
    blockTag: 'pending',
  });
  const gasPrice = await childClient.getGasPrice();

  // 2. Sign a plain EIP-1559 tx with the controller's key. This produces the RLP that
  //    Nitro will broadcast — the express-lane envelope only wraps it for delivery.
  const rlpTx = (await controllerAccount.signTransaction({
    chainId,
    type: 'eip1559',
    to,
    value: parseEther(valueEth),
    gas: 100_000n,
    maxFeePerGas: gasPrice * 2n,
    maxPriorityFeePerGas: gasPrice,
    nonce,
    data: '0x',
  })) as Hex;

  const txHash = keccak256(rlpTx);

  // 3. EIP-191-sign the express-lane envelope over the exact byte layout Nitro expects.
  const elSignature = await signExpressLaneSubmission(controllerAccount, {
    chainId: BigInt(chainId),
    auctionContractAddress,
    round,
    sequenceNumber,
    rlpTx,
  });

  // 4. Build the JSON-RPC payload (field shapes mirror Nitro's JsonExpressLaneSubmission).
  const submission: JsonExpressLaneSubmission = {
    chainId: toHex(chainId),
    round: toHex(round),
    auctionContractAddress,
    transaction: rlpTx,
    options: null,
    sequenceNumber: toHex(sequenceNumber),
    signature: elSignature,
  };

  // 5. POST. We measure sentAtMs immediately before the network call so the
  //    timeline plot reflects client-side intent, not RPC roundtrip latency.
  const sentAtMs = Date.now();
  await rawRpcCall(sequencerRpcUrl, 'timeboost_sendExpressLaneTransaction', [submission]);

  activeLogger.event(`[${label}] express-lane tx submitted: ${txHash} (round=${round}, seq=${sequenceNumber})`);

  return { txHash, sentAtMs, rlpTx, submission };
}

/**
 * Convenience: yield the partial TxObservation that the experiment recorder
 * will later complete with on-chain receipt fields.
 */
export function partialObservationForExpressLane(
  result: ExpressLaneSubmitResult,
  controllerAddress: Address,
  round: number,
): Pick<TxObservation, 'lane' | 'sentAtMs' | 'txHash' | 'sender' | 'round'> {
  return {
    lane: 'express',
    sentAtMs: result.sentAtMs,
    txHash: result.txHash,
    sender: controllerAddress,
    round,
  };
}

// ---------------------------------------------------------------------------
// Minimal JSON-RPC client
// ---------------------------------------------------------------------------

interface JsonRpcError {
  code: number;
  message: string;
}

interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  id: number | string;
  result?: T;
  error?: JsonRpcError;
}

/** Error thrown on JSON-RPC error responses. Carries the upstream `code` + `message`. */
export class TimeboostRpcError extends Error {
  constructor(
    public readonly method: string,
    public readonly rpcCode: number,
    public readonly rpcMessage: string,
  ) {
    super(`RPC ${method} failed: ${rpcMessage}`);
    this.name = 'TimeboostRpcError';
  }
}

/**
 * Fetch-based JSON-RPC caller. We avoid viem's transport here because
 * `timeboost_sendExpressLaneTransaction` returns `null` on success, which some
 * viem versions reject as "missing result".
 */
export async function rawRpcCall<T = unknown>(url: string, method: string, params: unknown[]): Promise<T | null> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

  if (!res.ok) {
    throw new Error(`RPC ${method} HTTP ${res.status}: ${await res.text()}`);
  }

  const body = (await res.json()) as JsonRpcResponse<T>;
  if (body.error) {
    throw new TimeboostRpcError(method, body.error.code, body.error.message);
  }
  return body.result ?? null;
}
