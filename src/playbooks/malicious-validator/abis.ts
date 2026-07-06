/**
 * Contract ABI definitions for the Malicious Validator Playbook
 *
 * Most ABIs are imported from @arbitrum/sdk to ensure compatibility.
 * Custom ABIs (like ArbMinter) are defined manually as they are
 * project-specific precompiles.
 */

import { ArbSys__factory } from '@arbitrum/sdk/dist/lib/abi/factories/ArbSys__factory.js';
import { Inbox__factory } from '@arbitrum/sdk/dist/lib/abi/factories/Inbox__factory.js';
import { ISequencerInbox__factory } from '@arbitrum/sdk/dist/lib/abi/factories/ISequencerInbox__factory.js';
import { IRollupCore__factory } from '@arbitrum/sdk/dist/lib/abi/factories/IRollupCore__factory.js';
import { BoldRollupUserLogic__factory } from '@arbitrum/sdk/dist/lib/abi-bold/factories/BoldRollupUserLogic__factory.js';

/**
 * ArbSys precompile ABI (0x64)
 * Used for L2-to-L1 withdrawals via withdrawEth
 */
export const arbSysAbi = ArbSys__factory.abi;

/**
 * Inbox contract ABI
 * Used for L1-to-L2 deposits via depositEth
 */
export const inboxAbi = Inbox__factory.abi;

/**
 * SequencerInbox contract ABI
 * Used for monitoring batch count
 */
export const sequencerInboxAbi = ISequencerInbox__factory.abi;

/**
 * RollupCore contract ABI
 * Used for monitoring assertions, stakers, and confirmation status
 */
export const rollupCoreAbi = IRollupCore__factory.abi;

/**
 * ArbMinter precompile ABI (0x74)
 * This is a project-specific precompile for malicious minting.
 * Not part of standard Arbitrum - only exists in test/demo chains.
 */
export const arbMinterAbi = [
  {
    inputs: [
      { internalType: 'address', name: 'account', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
    ],
    name: 'mintBalanceTo',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'address', name: 'account', type: 'address' },
      { indexed: false, internalType: 'uint256', name: 'amount', type: 'uint256' },
    ],
    name: 'BalanceMinted',
    type: 'event',
  },
] as const;

/**
 * EdgeChallengeManager contract ABI (events only)
 * No reference to EdgeChallengeManager contract in @arbitrum/sdk
 */
export const edgeChallengeManagerAbi = [
  // EdgeAdded - A new edge has been added to the challenge manager
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'bytes32', name: 'edgeId', type: 'bytes32' },
      { indexed: true, internalType: 'bytes32', name: 'mutualId', type: 'bytes32' },
      { indexed: true, internalType: 'bytes32', name: 'originId', type: 'bytes32' },
      { indexed: false, internalType: 'bytes32', name: 'claimId', type: 'bytes32' },
      { indexed: false, internalType: 'uint256', name: 'length', type: 'uint256' },
      { indexed: false, internalType: 'uint8', name: 'level', type: 'uint8' },
      { indexed: false, internalType: 'bool', name: 'hasRival', type: 'bool' },
      { indexed: false, internalType: 'bool', name: 'isLayerZero', type: 'bool' },
    ],
    name: 'EdgeAdded',
    type: 'event',
  },
  // EdgeBisected - An edge has been bisected
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'bytes32', name: 'edgeId', type: 'bytes32' },
      { indexed: true, internalType: 'bytes32', name: 'lowerChildId', type: 'bytes32' },
      { indexed: true, internalType: 'bytes32', name: 'upperChildId', type: 'bytes32' },
      { indexed: false, internalType: 'bool', name: 'lowerChildAlreadyExists', type: 'bool' },
    ],
    name: 'EdgeBisected',
    type: 'event',
  },
  // EdgeConfirmedByTime - Edge confirmed by cumulative unrivaled time
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'bytes32', name: 'edgeId', type: 'bytes32' },
      { indexed: true, internalType: 'bytes32', name: 'mutualId', type: 'bytes32' },
      { indexed: false, internalType: 'uint256', name: 'totalTimeUnrivaled', type: 'uint256' },
    ],
    name: 'EdgeConfirmedByTime',
    type: 'event',
  },
  // EdgeConfirmedByOneStepProof - SmallStep edge confirmed via one step proof
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'bytes32', name: 'edgeId', type: 'bytes32' },
      { indexed: true, internalType: 'bytes32', name: 'mutualId', type: 'bytes32' },
    ],
    name: 'EdgeConfirmedByOneStepProof',
    type: 'event',
  },
  // TimerCacheUpdated - Edge timer cache has been updated
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'bytes32', name: 'edgeId', type: 'bytes32' },
      { indexed: false, internalType: 'uint256', name: 'newValue', type: 'uint256' },
    ],
    name: 'TimerCacheUpdated',
    type: 'event',
  },
  // EdgeRefunded - Stake refunded for confirmed layer zero block edge
  {
    anonymous: false,
    inputs: [
      { indexed: true, internalType: 'bytes32', name: 'edgeId', type: 'bytes32' },
      { indexed: true, internalType: 'bytes32', name: 'mutualId', type: 'bytes32' },
      { indexed: false, internalType: 'address', name: 'stakeToken', type: 'address' },
      { indexed: false, internalType: 'uint256', name: 'stakeAmount', type: 'uint256' },
    ],
    name: 'EdgeRefunded',
    type: 'event',
  },
  // View function to get edge details
  {
    inputs: [{ internalType: 'bytes32', name: 'edgeId', type: 'bytes32' }],
    name: 'getEdge',
    outputs: [
      {
        components: [
          { internalType: 'bytes32', name: 'startHistoryRoot', type: 'bytes32' },
          { internalType: 'uint256', name: 'startHeight', type: 'uint256' },
          { internalType: 'bytes32', name: 'endHistoryRoot', type: 'bytes32' },
          { internalType: 'uint256', name: 'endHeight', type: 'uint256' },
          { internalType: 'bytes32', name: 'lowerChildId', type: 'bytes32' },
          { internalType: 'bytes32', name: 'upperChildId', type: 'bytes32' },
          { internalType: 'bytes32', name: 'claimId', type: 'bytes32' },
          { internalType: 'address', name: 'staker', type: 'address' },
          { internalType: 'uint64', name: 'createdAtBlock', type: 'uint64' },
          { internalType: 'uint64', name: 'confirmedAtBlock', type: 'uint64' },
          { internalType: 'uint8', name: 'status', type: 'uint8' },
          { internalType: 'uint8', name: 'level', type: 'uint8' },
          { internalType: 'bool', name: 'refunded', type: 'bool' },
          { internalType: 'uint64', name: 'totalTimeUnrivaledCache', type: 'uint64' },
        ],
        internalType: 'struct ChallengeEdge',
        name: '',
        type: 'tuple',
      },
    ],
    stateMutability: 'view',
    type: 'function',
  },
  // Check if edge has a rival
  {
    inputs: [{ internalType: 'bytes32', name: 'edgeId', type: 'bytes32' }],
    name: 'hasRival',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  // Check if edge exists
  {
    inputs: [{ internalType: 'bytes32', name: 'edgeId', type: 'bytes32' }],
    name: 'edgeExists',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  // Get edge length
  {
    inputs: [{ internalType: 'bytes32', name: 'edgeId', type: 'bytes32' }],
    name: 'edgeLength',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/**
 * BoLD Rollup events ABI
 * These events are specific to BoLD (Bounded Liquidity Delay) rollups.
 *
 * Note: In @arbitrum/sdk@4.x, the legacy rollup factories under `abi/factories/`
 * do not include BoLD assertion events. The BoLD ABI lives under `abi-bold/`.
 */
export const boldRollupEventsAbi = BoldRollupUserLogic__factory.abi;
