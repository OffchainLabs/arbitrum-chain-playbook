/**
 * Challenge Monitor
 *
 * Monitors EdgeChallengeManager events to track BoLD challenge progress.
 * Focused on three core events: EdgeAdded, EdgeBisected, EdgeConfirmedByOneStepProof.
 */

import { decodeEventLog, type PublicClient, type Address } from 'viem';
import logger from '../../utils/logger.js';
import { cancellableSleep } from '../../utils/cancellation.js';
import { edgeChallengeManagerAbi } from './abis.js';
import { type ChallengeState, type ChallengeEvent, type ChallengeEdge, EdgeStatus, EDGE_LEVEL_NAMES } from './types.js';

/**
 * Log type with topics for event processing
 */
type EventLog = {
  address: `0x${string}`;
  blockHash: `0x${string}`;
  blockNumber: bigint;
  data: `0x${string}`;
  logIndex: number;
  transactionHash: `0x${string}`;
  transactionIndex: number;
  removed: boolean;
  topics: readonly `0x${string}`[];
  args?: Record<string, unknown>;
};

/**
 * Global challenge monitor state
 */
let challengeState: ChallengeState = {
  running: false,
  edges: new Map(),
  events: [],
  totalEdgesCreated: 0,
  totalBisections: 0,
};

/**
 * Get level name for display
 */
function getLevelName(level: number): string {
  return EDGE_LEVEL_NAMES[level] || `Level${level}`;
}

/**
 * Format edge ID for display (shortened)
 */
function formatEdgeId(edgeId: string): string {
  if (edgeId.length <= 18) return edgeId;
  return `${edgeId.slice(0, 10)}...${edgeId.slice(-6)}`;
}

/**
 * Process EdgeAdded event
 * This is the only event that includes level (uint8).
 */
function processEdgeAdded(log: EventLog, blockNumber: bigint): ChallengeEvent | null {
  try {
    const args = log.args;
    if (!args) return null;

    const edgeId = args.edgeId as string;
    const mutualId = args.mutualId as string;
    const originId = args.originId as string;
    const claimId = args.claimId as string;
    const length = args.length as bigint;
    const level = Number(args.level);
    const hasRival = args.hasRival as boolean;
    const isLayerZero = args.isLayerZero as boolean;

    // Create edge record
    const edge: ChallengeEdge = {
      edgeId,
      mutualId,
      originId,
      level,
      startHeight: BigInt(0),
      endHeight: length,
      hasRival,
      isLayerZero,
      status: EdgeStatus.Pending,
      createdAtBlock: blockNumber,
    };
    challengeState.edges.set(edgeId, edge);
    challengeState.totalEdgesCreated++;

    const event: ChallengeEvent = {
      type: 'edge_added',
      edgeId,
      level,
      timestamp: new Date(),
      blockNumber,
      txHash: log.transactionHash,
      details: {
        mutualId,
        originId,
        claimId,
        length,
        hasRival,
        isLayerZero,
      },
    };
    challengeState.events.push(event);

    // Real-time logging
    const levelName = getLevelName(level);
    const rivalStr = hasRival ? ' (RIVAL!)' : '';
    const layerZeroStr = isLayerZero ? ' [LayerZero]' : '';
    logger.info(
      `[Challenge] Edge Added: ${levelName}, Length=${length}, ID=${formatEdgeId(edgeId)}${rivalStr}${layerZeroStr}`,
    );

    if (hasRival) {
      logger.success(`[Challenge] Rival edge detected at ${levelName} level — challenge is active.`);
    }

    if (length === BigInt(1) && level < 2) {
      logger.warn(
        `[Challenge] ${levelName} edge reached length=1 — node will compute next subchallenge locally, this may take some time.`,
      );
    } else if (length === BigInt(1) && level === 2) {
      logger.success(`[Challenge] SmallStep edge reached length=1 — waiting for one-step proof (OSP) transaction...`);
    }

    return event;
  } catch (error) {
    logger.debug(`Failed to process EdgeAdded event: ${error}`);
    return null;
  }
}

/**
 * Process EdgeBisected event
 * Note: EdgeBisected does NOT include level — we look it up from the parent edge.
 */
function processEdgeBisected(log: EventLog, blockNumber: bigint): ChallengeEvent | null {
  try {
    const args = log.args;
    if (!args) return null;

    const edgeId = args.edgeId as string;
    const lowerChildId = args.lowerChildId as string;
    const upperChildId = args.upperChildId as string;
    const lowerChildAlreadyExists = args.lowerChildAlreadyExists as boolean;

    challengeState.totalBisections++;

    // Look up level from parent edge
    const parentEdge = challengeState.edges.get(edgeId);
    const level = parentEdge?.level ?? -1;

    // Fix child edge start/end heights based on parent's range
    if (parentEdge) {
      const midpoint = parentEdge.startHeight + (parentEdge.endHeight - parentEdge.startHeight) / BigInt(2);
      const lowerChild = challengeState.edges.get(lowerChildId);
      const upperChild = challengeState.edges.get(upperChildId);
      if (lowerChild) {
        lowerChild.startHeight = parentEdge.startHeight;
        lowerChild.endHeight = midpoint;
      }
      if (upperChild) {
        upperChild.startHeight = midpoint;
        upperChild.endHeight = parentEdge.endHeight;
      }
    }

    const event: ChallengeEvent = {
      type: 'edge_bisected',
      edgeId,
      level,
      timestamp: new Date(),
      blockNumber,
      txHash: log.transactionHash,
      details: {
        lowerChildId,
        upperChildId,
        lowerChildAlreadyExists,
      },
    };
    challengeState.events.push(event);

    // Real-time logging
    const levelName = level >= 0 ? getLevelName(level) : 'Unknown';
    const existsStr = lowerChildAlreadyExists ? ' (lower already exists)' : '';
    logger.info(
      `[Challenge] Bisection #${challengeState.totalBisections}: ${levelName} edge ${formatEdgeId(edgeId)} split${existsStr}`,
    );
    logger.raw(`           Lower: ${formatEdgeId(lowerChildId)}, Upper: ${formatEdgeId(upperChildId)}`);

    return event;
  } catch (error) {
    logger.debug(`Failed to process EdgeBisected event: ${error}`);
    return null;
  }
}

/**
 * Process EdgeConfirmedByOneStepProof event (terminal event)
 * Note: This does NOT include level — we look it up from the edge.
 */
function processEdgeConfirmedByOneStepProof(log: EventLog, blockNumber: bigint): ChallengeEvent | null {
  try {
    const args = log.args;
    if (!args) return null;

    const edgeId = args.edgeId as string;
    const mutualId = args.mutualId as string;

    // Update edge status
    const edge = challengeState.edges.get(edgeId);
    if (edge) {
      edge.status = EdgeStatus.Confirmed;
      edge.confirmedAtBlock = blockNumber;
    }

    const level = edge?.level ?? -1;

    const event: ChallengeEvent = {
      type: 'edge_confirmed_osp',
      edgeId,
      level,
      timestamp: new Date(),
      blockNumber,
      txHash: log.transactionHash,
      details: {
        mutualId,
      },
    };
    challengeState.events.push(event);
    challengeState.confirmedEdgeId = edgeId;

    // Log victory immediately
    logger.newline();
    logger.success(`[Challenge] EdgeConfirmedByOneStepProof!`);
    logger.success(`[Challenge] Edge ID: ${formatEdgeId(edgeId)}`);
    logger.success(`[Challenge] TX Hash: ${log.transactionHash}`);
    logger.success(`[Challenge] Honest validator confirmed as winner!`);

    return event;
  } catch (error) {
    logger.debug(`Failed to process EdgeConfirmedByOneStepProof event: ${error}`);
    return null;
  }
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start the challenge monitor
 */
export async function startChallengeMonitor(
  parentClient: PublicClient,
  challengeManagerAddress: Address,
  pollIntervalMs: number = 3000,
): Promise<void> {
  // Reset state
  challengeState = {
    running: true,
    edges: new Map(),
    events: [],
    startTime: new Date(),
    totalEdgesCreated: 0,
    totalBisections: 0,
  };

  let lastProcessedBlock = await parentClient.getBlockNumber();
  logger.info(`[Challenge Monitor] Starting from block ${lastProcessedBlock}...`);
  logger.info(`[Challenge Monitor] Watching EdgeChallengeManager at ${challengeManagerAddress}`);

  const monitorLoop = async () => {
    while (challengeState.running) {
      try {
        const currentBlock = await parentClient.getBlockNumber();

        if (currentBlock > lastProcessedBlock) {
          const logs = await parentClient.getLogs({
            address: challengeManagerAddress,
            fromBlock: lastProcessedBlock + BigInt(1),
            toBlock: currentBlock,
          });

          for (const log of logs) {
            const blockNum = log.blockNumber ?? currentBlock;
            let decoded;
            try {
              decoded = decodeEventLog({
                abi: edgeChallengeManagerAbi,
                data: log.data,
                topics: log.topics,
              });
            } catch {
              continue;
            }

            const eventLog = {
              ...(log as unknown as EventLog),
              args: decoded.args as Record<string, unknown>,
            };

            switch (decoded.eventName) {
              case 'EdgeAdded':
                processEdgeAdded(eventLog, blockNum);
                break;
              case 'EdgeBisected':
                processEdgeBisected(eventLog, blockNum);
                break;
              case 'EdgeConfirmedByOneStepProof':
                processEdgeConfirmedByOneStepProof(eventLog, blockNum);
                break;
            }
          }

          lastProcessedBlock = currentBlock;
        }

        // Periodic status update every 30 seconds
        if (challengeState.startTime) {
          const elapsed = Math.floor((Date.now() - challengeState.startTime.getTime()) / 1000);
          if (elapsed > 0 && elapsed % 30 === 0) {
            logger.raw(
              `[Challenge Monitor] Status: ${challengeState.totalEdgesCreated} edges, ${challengeState.totalBisections} bisections, ${Math.floor(elapsed / 60)}m${elapsed % 60}s elapsed`,
            );
          }
        }
      } catch (error) {
        logger.debug(`[Challenge Monitor] Error polling events: ${error}`);
      }

      await sleep(pollIntervalMs);
    }
  };

  // Run monitor in background (non-blocking)
  monitorLoop().catch((err) => {
    logger.errorWithFix(
      `[Challenge Monitor] Fatal error: ${err}`,
      'Verify PARENT_CHAIN_RPC is reachable and the challengeManager address is correct.',
    );
    challengeState.running = false;
  });
}

/**
 * Stop the challenge monitor
 */
export function stopChallengeMonitor(): void {
  challengeState.running = false;
  challengeState.endTime = new Date();
  logger.info('[Challenge Monitor] Stopping...');
}

/**
 * Get current challenge state
 */
export function getChallengeState(): ChallengeState {
  return { ...challengeState, edges: new Map(challengeState.edges) };
}

/**
 * Check if a challenge has been resolved
 */
export function isChallengeResolved(): boolean {
  return challengeState.confirmedEdgeId !== undefined;
}

/**
 * Wait for challenge resolution with timeout
 */
export async function waitForChallengeResolution(maxWaitSeconds: number, signal?: AbortSignal): Promise<string | null> {
  const startTime = Date.now();
  const maxWaitMs = maxWaitSeconds * 1000;

  logger.info(`[Challenge] Waiting for challenge resolution (max ${Math.floor(maxWaitSeconds / 60)} min)...`);

  while (Date.now() - startTime < maxWaitMs) {
    if (isChallengeResolved()) {
      return challengeState.confirmedEdgeId!;
    }

    if (!challengeState.running) {
      logger.warn('[Challenge] Monitor stopped unexpectedly');
      return null;
    }

    await cancellableSleep(2000, signal);

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (elapsed % 60 === 0 && elapsed > 0) {
      logger.info(`[Challenge] Still waiting... (${Math.floor(elapsed / 60)}m / ${Math.floor(maxWaitSeconds / 60)}m)`);
    }
  }

  logger.warn(`[Challenge] Timeout waiting for resolution after ${Math.floor(maxWaitSeconds / 60)} min`);
  return null;
}

/**
 * Reconstruct bisection paths from collected events (called after OSP)
 */
export function reconstructBisectionPaths(): {
  block: Array<[bigint, bigint]>;
  bigStep: Array<[bigint, bigint]>;
  smallStep: Array<[bigint, bigint]>;
} {
  const paths: {
    block: Array<[bigint, bigint]>;
    bigStep: Array<[bigint, bigint]>;
    smallStep: Array<[bigint, bigint]>;
  } = { block: [], bigStep: [], smallStep: [] };

  // Collect layer-zero edges per level to find initial ranges
  for (const event of challengeState.events) {
    if (event.type === 'edge_added' && event.details.isLayerZero && !event.details.hasRival) {
      const length = event.details.length ?? BigInt(0);
      const entry: [bigint, bigint] = [BigInt(0), length];
      if (event.level === 0) paths.block.push(entry);
      else if (event.level === 1) paths.bigStep.push(entry);
      else if (event.level === 2) paths.smallStep.push(entry);
    }
  }

  // Track bisection narrowing by following child edges with rivals
  for (const event of challengeState.events) {
    if (event.type === 'edge_bisected') {
      const lowerChildId = event.details.lowerChildId;
      const upperChildId = event.details.upperChildId;
      if (!lowerChildId || !upperChildId) continue;

      const lowerChild = challengeState.edges.get(lowerChildId);
      const upperChild = challengeState.edges.get(upperChildId);
      if (!lowerChild || !upperChild) continue;

      const tracked = lowerChild.hasRival ? lowerChild : upperChild.hasRival ? upperChild : null;
      if (tracked) {
        const entry: [bigint, bigint] = [tracked.startHeight, tracked.endHeight];
        if (tracked.level === 0) paths.block.push(entry);
        else if (tracked.level === 1) paths.bigStep.push(entry);
        else if (tracked.level === 2) paths.smallStep.push(entry);
      }
    }
  }

  return paths;
}

/**
 * Print challenge summary with bisection path analysis (called after OSP or timeout)
 */
export function printChallengeSummary(): void {
  const state = challengeState;

  logger.section('Challenge Summary');

  if (state.startTime && state.endTime) {
    const durationMs = state.endTime.getTime() - state.startTime.getTime();
    const durationMin = Math.floor(durationMs / 60000);
    const durationSec = Math.floor((durationMs % 60000) / 1000);
    logger.raw(`  Duration: ${durationMin}m ${durationSec}s`);
  }

  logger.raw(`  Total edges created: ${state.totalEdgesCreated}`);
  logger.raw(`  Total bisections: ${state.totalBisections}`);
  logger.raw(`  Events recorded: ${state.events.length}`);

  if (state.confirmedEdgeId) {
    logger.success(`  Winner: Honest validator (Edge ${formatEdgeId(state.confirmedEdgeId)} confirmed by OSP)`);

    const ospEvent = state.events.find((e) => e.type === 'edge_confirmed_osp' && e.edgeId === state.confirmedEdgeId);
    if (ospEvent?.txHash) {
      logger.raw(`  OSP TX Hash: ${ospEvent.txHash}`);
    }
  } else {
    logger.warn(`  Result: No edge confirmed yet`);
  }

  // Bisection path analysis (only after challenge completed)
  if (state.confirmedEdgeId) {
    const paths = reconstructBisectionPaths();

    logger.newline();
    logger.raw('  === Bisection Path Analysis ===');

    const printPath = (label: string, path: Array<[bigint, bigint]>) => {
      if (path.length === 0) return;
      const formatted = path.map(([s, e]) => `[${s}, ${e}]`).join(' -> ');
      logger.raw(`  [${label}] ${formatted}`);
    };

    printPath('Block', paths.block);
    printPath('BigStep', paths.bigStep);
    printPath('SmallStep', paths.smallStep);
  }

  // Event timeline (last 15 events)
  if (state.events.length > 0) {
    logger.newline();
    logger.raw('  Event Timeline (last 15):');
    for (const event of state.events.slice(-15)) {
      const time = event.timestamp.toISOString().split('T')[1].split('.')[0];
      const levelName = event.level >= 0 ? getLevelName(event.level) : '';
      logger.raw(`    [${time}] ${event.type} ${levelName} ${formatEdgeId(event.edgeId)}`);
    }
    if (state.events.length > 15) {
      logger.raw(`    ... and ${state.events.length - 15} more events`);
    }
  }
}
