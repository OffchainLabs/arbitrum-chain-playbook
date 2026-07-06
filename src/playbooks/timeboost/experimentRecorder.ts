/**
 * Run an experiment pair: one express-lane tx and one normal tx fired off
 * (as close to) simultaneously, then collect their receipts and observe
 * the `timeboosted` field that the sequencer attaches when block metadata
 * tracking is enabled.
 *
 * The `timeboosted` field is set by go-ethereum/internal/ethapi/api.go:1786
 * inside the receipt builder. It is therefore read via
 * `eth_getTransactionReceipt`, NOT `eth_getTransactionByHash`. The field is
 * absent on chains where `track-block-metadata-from` is not configured.
 */

import { type Address, type Hash, type Hex, type LocalAccount, type PublicClient, parseEther } from 'viem';
import { submitExpressLaneTransaction, type ExpressLaneSubmitInput } from './expressLaneRunner.js';
import type { ExperimentRecord, TxObservation } from './types.js';
import { log, signRawTx } from './util.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunExperimentInput {
  index: number;
  round: number;
  controller: Address;

  /** Submit one express-lane tx using these settings. */
  expressLaneSubmit: Omit<ExpressLaneSubmitInput, 'label'>;

  /** Submit one normal tx using these settings. */
  normalTx: NormalTxInput;

  /** Public client for receipt + block lookups (we use it for both lanes). */
  childClient: PublicClient;

  /**
   * How long to poll for each receipt before giving up.
   * Default 30s — well above 250ms blocktime + a few re-orgs.
   */
  receiptTimeoutMs?: number;
}

export interface NormalTxInput {
  /** Sender that does NOT hold the express lane right (e.g. "Dave"). */
  senderAccount: LocalAccount<string>;
  childClient: PublicClient;
  chainId: number;
  to: Address;
  valueEth?: string;
}

/**
 * Run a single express-vs-normal pair within `round`.
 *
 * IMPORTANT: each lane fuses its own submit+poll into a single async task.
 * If we instead did `Promise.all([submitEL, submitN])` and then started
 * polling, the EL lane's polling would be gated on Normal's submit returning
 * — which is itself bottlenecked by `PublishTransaction`'s blocking wait on
 * `<-resultChan` (sequencer.go:540-542). That made EL `receiptAtMs` and
 * Normal `receiptAtMs` collapse to the same wall-clock instant, hiding the
 * actual ~200ms wall-clock gap that Timeboost induces.
 */
export async function runExperimentPair(input: RunExperimentInput): Promise<ExperimentRecord> {
  const { index, round, controller, expressLaneSubmit, normalTx, childClient, receiptTimeoutMs = 30_000 } = input;

  log.section(`Experiment #${index + 1}: round ${round}`);

  const elTask = (async () => {
    const sub = await submitExpressLaneTransaction({
      ...expressLaneSubmit,
      label: `pair#${index}/express`,
    });
    return completeObservation({
      lane: 'express',
      childClient,
      txHash: sub.txHash,
      sentAtMs: sub.sentAtMs,
      sender: controller,
      round,
      timeoutMs: receiptTimeoutMs,
    });
  })();

  const normalTask = (async () => {
    const sub = await submitNormalTx({ ...normalTx, label: `pair#${index}/normal` });
    return completeObservation({
      lane: 'normal',
      childClient,
      txHash: sub.txHash,
      sentAtMs: sub.sentAtMs,
      sender: normalTx.senderAccount.address,
      round,
      timeoutMs: receiptTimeoutMs,
    });
  })();

  const [elObs, normalObs] = await Promise.all([elTask, normalTask]);

  printPairSummary(elObs, normalObs);

  return { index, round, controller, expressLane: elObs, normal: normalObs };
}

// ---------------------------------------------------------------------------
// Normal tx submission (exported so the no-bid round demo can reuse it
// instead of hand-rolling the same nonce/gas/sign/send dance)
// ---------------------------------------------------------------------------

export interface SubmitNormalTxInput extends NormalTxInput {
  label: string;
}

export interface SubmitNormalTxResult {
  txHash: Hash;
  sentAtMs: number;
}

export async function submitNormalTx(input: SubmitNormalTxInput): Promise<SubmitNormalTxResult> {
  const { senderAccount, childClient, chainId, to, valueEth = '0', label } = input;

  const rlpTx = await signRawTx(childClient, senderAccount, { to, value: parseEther(valueEth), chainId });

  const sentAtMs = Date.now();
  const txHash = await childClient.sendRawTransaction({ serializedTransaction: rlpTx });

  log.event(`[${label}] normal tx submitted: ${txHash}`);

  return { txHash, sentAtMs };
}

// ---------------------------------------------------------------------------
// Receipt polling + timeboosted extraction (exported for the no-bid round path)
// ---------------------------------------------------------------------------

export interface CompleteObservationInput {
  lane: TxObservation['lane'];
  childClient: PublicClient;
  txHash: Hash;
  sentAtMs: number;
  sender: Address;
  round: number;
  timeoutMs: number;
}

export async function completeObservation(input: CompleteObservationInput): Promise<TxObservation> {
  const { childClient, txHash, sentAtMs, sender, lane, round, timeoutMs } = input;

  // Use a tighter poll than the default — we want a wall-clock-accurate
  // `receiptAtMs` for the timeline, and 250ms quanta would smear out the
  // 200ms Timeboost delay we're trying to visualise.
  const receipt = await childClient.waitForTransactionReceipt({
    hash: txHash,
    timeout: timeoutMs,
    pollingInterval: 50,
  });
  const receiptAtMs = Date.now();

  // viem's typed receipt does NOT surface Arbitrum-specific fields. We re-fetch
  // the raw JSON via the transport and pluck `timeboosted` ourselves.
  const rawReceipt = (await childClient.transport.request({
    method: 'eth_getTransactionReceipt',
    params: [txHash],
  })) as Record<string, unknown> | null;

  const timeboosted = readTimeboostedField(rawReceipt);

  // Block timestamp (kept for the raw table; not used on the timeline).
  const block = await childClient.getBlock({ blockNumber: receipt.blockNumber });

  return {
    lane,
    sentAtMs,
    receiptAtMs,
    txHash,
    blockNumber: receipt.blockNumber,
    blockTimestampSec: block.timestamp,
    txIndex: receipt.transactionIndex,
    timeboosted,
    sender,
    round,
  };
}

/**
 * Pull the `timeboosted` boolean from the raw receipt JSON.
 * Returns `null` when the field is absent — typically because the sequencer
 * does not have `node.transaction-streamer.track-block-metadata-from` set.
 */
function readTimeboostedField(rawReceipt: Record<string, unknown> | null): boolean | null {
  if (!rawReceipt || typeof rawReceipt !== 'object') return null;
  const v = rawReceipt['timeboosted'];
  if (typeof v === 'boolean') return v;
  return null;
}

// ---------------------------------------------------------------------------
// Internals — pretty CLI output
// ---------------------------------------------------------------------------

function printPairSummary(el: TxObservation, normal: TxObservation): void {
  const lag = (o: TxObservation): string => {
    // Best-effort: client wall-clock to block-timestamp diff in ms.
    const blockMs = Number(o.blockTimestampSec) * 1000;
    return `${blockMs - o.sentAtMs}ms`;
  };

  log.raw(
    `  express   block=${el.blockNumber} idx=${el.txIndex}     timeboosted=${fmt(el.timeboosted)}  delta=${lag(el)}`,
  );
  log.raw(
    `  normal    block=${normal.blockNumber} idx=${normal.txIndex}     timeboosted=${fmt(normal.timeboosted)}  delta=${lag(normal)}`,
  );

  if (el.blockNumber < normal.blockNumber) {
    log.success(`  → normal tx landed ${normal.blockNumber - el.blockNumber} block(s) later than express tx`);
  } else if (el.blockNumber === normal.blockNumber && el.txIndex < normal.txIndex) {
    log.success(`  → both in same block; express tx is ordered first (idx ${el.txIndex} vs ${normal.txIndex})`);
  } else {
    log.warn(`  → no visible ordering advantage this run (timing nondeterminism — repeat to see statistical pattern)`);
  }
}

function fmt(v: boolean | null): string {
  if (v === null) return 'absent';
  return v ? 'true' : 'false';
}
