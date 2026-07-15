/**
 * Type definitions for the Malicious Validator Playbook
 */

import type { Address } from 'viem';

/**
 * Configuration for the malicious mint demo
 */
export interface MaliciousMintConfig {
  mainDepositAmount: bigint;
  hackerDepositAmount: bigint;
  hackerFundingAmount: bigint;
}

/**
 * Result from the malicious mint demo
 */
export interface MaliciousMintResult {
  /** False when the demo aborted before completing (early-exit paths). */
  success: boolean;
  mainAddress: Address;
  hackerAddress: Address;
  hackerPrivateKey: `0x${string}`;
  mintAmount: bigint;
  withdrawAmount: bigint;
  confirmPeriodBlocks: bigint;
  bridgeBalanceInitial: bigint;
  bridgeBalanceFinal: bigint;
}

/**
 * Default configuration values
 */
export const DEFAULT_MALICIOUS_MINT_CONFIG: MaliciousMintConfig = {
  mainDepositAmount: BigInt('5000000000000000'), // 0.005 ETH
  hackerDepositAmount: BigInt('1000000000000000'), // 0.001 ETH
  hackerFundingAmount: BigInt('2000000000000000'), // 0.002 ETH (extra for gas)
};

/**
 * Precompile addresses
 */
export const ARB_SYS_ADDRESS = '0x0000000000000000000000000000000000000064' as const;
export const ARB_MINTER_ADDRESS = '0x0000000000000000000000000000000000000074' as const;

/**
 * Monitor state for tracking rollup activity
 */
export interface MonitorState {
  running: boolean;
  lastBatchCount: bigint;
  lastConfirmed: string;
  stakerCount: bigint;
  newAssertions: Array<{
    hash: string;
    parent: string;
    block: bigint;
  }>;
}

/**
 * Rollup status information
 */
export interface RollupStatus {
  batchCount: bigint;
  latestConfirmed: string;
  stakerCount: bigint;
  confirmPeriodBlocks: bigint;
}

// =============================================================================
// Challenge Demo Types
// =============================================================================

/**
 * Edge level names for display
 * Level 0 = Block, Level 1-N = BigStep, Level N+1 = SmallStep
 */
export const EDGE_LEVEL_NAMES: Record<number, string> = {
  0: 'Block',
  1: 'BigStep',
  2: 'SmallStep',
};

/**
 * Edge status enum (matches on-chain EdgeStatus)
 */
export enum EdgeStatus {
  Pending = 0,
  Confirmed = 1,
}

/**
 * Challenge event types (focused on core challenge flow)
 */
export type ChallengeEventType = 'edge_added' | 'edge_bisected' | 'edge_confirmed_osp';

/**
 * Challenge event data
 */
export interface ChallengeEvent {
  type: ChallengeEventType;
  edgeId: string;
  level: number;
  timestamp: Date;
  blockNumber: bigint;
  txHash?: string;
  details: {
    mutualId?: string;
    originId?: string;
    claimId?: string;
    length?: bigint;
    hasRival?: boolean;
    isLayerZero?: boolean;
    lowerChildId?: string;
    upperChildId?: string;
    lowerChildAlreadyExists?: boolean;
  };
}

/**
 * Edge information for tracking
 */
export interface ChallengeEdge {
  edgeId: string;
  mutualId: string;
  originId: string;
  level: number;
  startHeight: bigint;
  endHeight: bigint;
  hasRival: boolean;
  isLayerZero: boolean;
  status: EdgeStatus;
  staker?: string;
  createdAtBlock: bigint;
  confirmedAtBlock?: bigint;
}

/**
 * Challenge state for tracking progress
 */
export interface ChallengeState {
  running: boolean;
  edges: Map<string, ChallengeEdge>;
  events: ChallengeEvent[];
  startTime?: Date;
  endTime?: Date;
  winner?: 'honest' | 'malicious' | 'unknown';
  totalEdgesCreated: number;
  totalBisections: number;
  confirmedEdgeId?: string;
}

/**
 * Challenge demo configuration
 */
export interface ChallengeDemoConfig {
  /** Maximum time to wait for challenge completion (in seconds) */
  maxWaitSeconds: number;
  /** Interval for polling events (in milliseconds) */
  pollIntervalMs: number;
  /** Number of L1 deposits for non-linear bisection */
  delayedMessageCount: number;
  /** ETH per delayed message */
  delayedMessageAmount: bigint;
  /** Number of L2 transactions to trigger divergence */
  childChainTxCount: number;
}

/**
 * Default challenge demo configuration
 */
export const DEFAULT_CHALLENGE_DEMO_CONFIG: ChallengeDemoConfig = {
  maxWaitSeconds: 10800, // 3 hours (challenge can take 30-60+ minutes)
  pollIntervalMs: 3000, // 3 seconds
  delayedMessageCount: 10,
  delayedMessageAmount: BigInt('100000000000000'), // 0.0001 ETH
  childChainTxCount: 5,
};

/**
 * Challenge demo result
 */
export interface ChallengeDemoResult {
  success: boolean;
  winner?: 'honest' | 'malicious' | 'timeout';
  totalEdges: number;
  totalBisections: number;
  durationMs: number;
  confirmedEdgeId?: string;
  ospTxHash?: string;
  events: ChallengeEvent[];
  bisectionPaths: {
    block: Array<[bigint, bigint]>;
    bigStep: Array<[bigint, bigint]>;
    smallStep: Array<[bigint, bigint]>;
  };
}
