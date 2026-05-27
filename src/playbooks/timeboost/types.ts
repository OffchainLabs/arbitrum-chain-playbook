/**
 * Type definitions for the Timeboost Playbook — shared across the experiment
 * recorder, auction monitor, and HTML report.
 */

import type { Address, Hex, Hash } from 'viem';

// =============================================================================
// Express Lane submission (mirrors nitro/timeboost/types.go JsonExpressLaneSubmission)
// =============================================================================

/**
 * JSON-RPC payload accepted by `timeboost_sendExpressLaneTransaction`.
 * Field names and shapes must match nitro/timeboost/types.go:JsonExpressLaneSubmission.
 */
export interface JsonExpressLaneSubmission {
  chainId: Hex;
  round: Hex;
  auctionContractAddress: Address;
  transaction: Hex;
  // The demo never sets ConditionalOptions; nitro's contract allows the full
  // arbitrum-types ConditionalOptions object here but we always send null.
  options: null;
  sequenceNumber: Hex;
  signature: Hex;
}

/**
 * Special sentinel sequence number that bypasses the per-round reordering queue.
 * Equivalent to nitro/timeboost/express_lane_service.go: `DontCareSequence = math.MaxUint64`.
 */
export const DONT_CARE_SEQUENCE = (1n << 64n) - 1n;

// =============================================================================
// Experiment recording (Phase 6 → consumed by Phase 7 report)
// =============================================================================

/** Whether this tx was sent through the express lane or the normal RPC path. */
export type TxLane = 'express' | 'normal';

/**
 * Single observation of a transaction's life: client send time → on-chain inclusion.
 * Used by both experiment pairs and unauthorized-tx attempts.
 */
export interface TxObservation {
  lane: TxLane;
  /** Client-side Date.now() right before the submit RPC. */
  sentAtMs: number;
  /** Client-side Date.now() right after the receipt was returned. */
  receiptAtMs: number;
  txHash: Hash;
  blockNumber: bigint;
  blockTimestampSec: bigint; // chain-side, second-granularity (kept for raw table)
  txIndex: number;
  /** Read from eth_getTransactionReceipt; requires sequencer to have track-block-metadata-from >= 1. */
  timeboosted: boolean | null;
  sender: Address;
  /** Round at which the tx was submitted (best-effort, captured client-side). */
  round: number;
}

/** A pair of parallel txs (one express, one normal) sent within the same round. */
export interface ExperimentRecord {
  index: number; // 0..N within the demo
  round: number;
  controller: Address;
  expressLane: TxObservation;
  normal: TxObservation;
}

/** Outcome of the negative-path demo: a non-controller tries to use the express lane. */
export interface UnauthorizedAttemptRecord {
  attemptedAtMs: number;
  attempterAddress: Address;
  round: number;
  /** Error text returned by the sequencer; expected to contain "NOT_EXPRESS_LANE_CONTROLLER". */
  errorMessage: string;
  recognised: boolean; // true iff errorMessage contains the expected sentinel
}

// =============================================================================
// Report data (Phase 7)
// =============================================================================

/** Summary card metrics displayed at the top of the HTML report. */
export interface ReportSummary {
  totalExperiments: number;
  expressTimeboostedCount: number; // expected == totalExperiments
  normalTimeboostedCount: number; // expected == 0
  expressMedianLatencyMs: number;
  normalMedianLatencyMs: number;
  crossBlockNormalCount: number; // # normal txs that landed in a later block than their EL pair
  noBidRoundsObserved: number;
  unauthorizedAttempts: number;
  unauthorizedRecognisedCount: number;
}

/** AuctionResolved / SetExpressLaneController event captured during the demo. */
export interface AuctionEvent {
  blockNumber: bigint;
  txHash: Hash;
  kind: 'AuctionResolved' | 'SetExpressLaneController' | 'Deposit' | 'Other';
  /** Pretty-printed payload for the report's event feed. */
  description: string;
  raw?: Record<string, unknown>;
}

/** A round in which no auction was resolved (or no bids met reserve). */
export interface NoBidRoundRecord {
  round: number;
  startedAtMs: number;
  observations: TxObservation[]; // tx sent during that round, expected timeboosted=false
}

/** Top-level data passed to the report renderer. */
export interface ReportData {
  generatedAtIso: string;
  chainId: number;
  auctionContract: Address;
  biddingToken: Address;
  roundDurationSeconds: number;
  auctionClosingSeconds: number;
  reserveSubmissionSeconds: number;
  nonExpressDelayMsec: number;

  experiments: ExperimentRecord[];
  noBidRounds: NoBidRoundRecord[];
  unauthorized: UnauthorizedAttemptRecord[];
  events: AuctionEvent[];
  summary: ReportSummary;
}
