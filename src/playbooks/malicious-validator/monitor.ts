/**
 * Rollup monitoring functionality for the Malicious Validator Playbook
 *
 * Monitors sequencer inbox batches, validator assertions, and confirmation status.
 */

import type { PublicClient, Address } from 'viem';
import type { CoreContracts } from '@arbitrum/chain-sdk';
import { utils } from 'ethers';
import logger from '../../utils/logger.js';
import { cancellableSleep } from '../../utils/cancellation.js';
import { normalizeBytes32Like } from '../../utils/bytes32.js';
import { sequencerInboxAbi, rollupCoreAbi, boldRollupEventsAbi } from './abis.js';
import type { MonitorState, RollupStatus } from './types.js';

/**
 * Global monitor state
 */
let monitorState: MonitorState = {
  running: false,
  lastBatchCount: BigInt(0),
  lastConfirmed: '',
  stakerCount: BigInt(0),
  newAssertions: [],
};

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Start the rollup monitor
 *
 * Monitors batch count, confirmed assertions, staker count, and new assertion events.
 * Runs in the background until stopRollupMonitor() is called.
 */
export async function startRollupMonitor(
  parentClient: PublicClient,
  coreContracts: CoreContracts,
  options?: {
    /** Child chain client (for reading Arbitrum-specific block fields like sendCount via raw RPC). */
    childClient?: PublicClient;
    /** Track when a specific L2->L1 message position becomes included/confirmed in assertions. */
    watchMessage?: {
      /** 0-indexed outgoing message position (as emitted in ArbSys L2ToL1Tx.position). */
      position: bigint;
      /** Optional label for log output. */
      label?: string;
    };
  },
): Promise<void> {
  monitorState.running = true;
  monitorState.newAssertions = [];
  let lastProcessedBlock = await parentClient.getBlockNumber();
  let lastErrorLogMs = 0;
  // Use BoLD-specific ABI for assertion events (SDK's IRollupCore uses legacy NodeCreated/NodeConfirmed)
  const boldInterface = new utils.Interface(boldRollupEventsAbi as any);
  const assertionCreatedTopic = boldInterface.getEventTopic('AssertionCreated');
  const assertionConfirmedTopic = boldInterface.getEventTopic('AssertionConfirmed');

  logger.info('[Monitor] Starting background monitoring...');

  const watch = options?.watchMessage;
  const childClient = options?.childClient;
  const watchEnabled = Boolean(watch && childClient);
  const watchLabel = watch?.label ? ` (${watch.label})` : '';
  if (watchEnabled && watch) {
    logger.info(`[Monitor] Watching L2->L1 message position ${watch.position}${watchLabel}...`);
  }

  const arbBlockSendCache = new Map<string, { sendCount: bigint; sendRoot?: string; number?: bigint }>();
  let firstCreatedContainingWatchedMessage: {
    assertionHash: string;
    parentAssertionHash: string;
    blockHash: string;
    sendRoot: string;
    sendCount: bigint;
  } | null = null;
  let firstConfirmedContainingWatchedMessage: {
    assertionHash: string;
    blockHash: string;
    sendRoot: string;
    sendCount: bigint;
  } | null = null;

  const getArbBlockSendInfo = async (
    blockHash: string,
  ): Promise<{ sendCount: bigint; sendRoot?: string; number?: bigint } | null> => {
    if (!childClient) return null;
    const key = normalizeBytes32Like(blockHash);
    const cached = arbBlockSendCache.get(key);
    if (cached) return cached;

    try {
      const request = (childClient as any).request ?? (childClient as any).transport?.request;
      if (!request) return null;

      const block = await request({
        method: 'eth_getBlockByHash',
        params: [key, false],
      });
      if (!block) return null;

      const sendCountHex = (block as any).sendCount as string | undefined;
      const sendRoot = (block as any).sendRoot as string | undefined;
      const numberHex = (block as any).number as string | undefined;

      if (!sendCountHex) return null;

      const info = {
        sendCount: BigInt(sendCountHex),
        sendRoot: sendRoot ? normalizeBytes32Like(sendRoot) : undefined,
        number: numberHex ? BigInt(numberHex) : undefined,
      };

      arbBlockSendCache.set(key, info);
      return info;
    } catch {
      return null;
    }
  };

  const monitorLoop = async () => {
    while (monitorState.running) {
      try {
        // 1. Monitor batch count
        const batchCount = await parentClient.readContract({
          address: coreContracts.sequencerInbox as Address,
          abi: sequencerInboxAbi,
          functionName: 'batchCount',
        });

        // 2. Monitor latest confirmed assertion
        const latestConfirmed = await parentClient.readContract({
          address: coreContracts.rollup as Address,
          abi: rollupCoreAbi,
          functionName: 'latestConfirmed',
        });

        // 3. Monitor staker count
        const stakerCount = await parentClient.readContract({
          address: coreContracts.rollup as Address,
          abi: rollupCoreAbi,
          functionName: 'stakerCount',
        });

        // 4. Monitor newly created assertions (via events)
        const currentBlock = await parentClient.getBlockNumber();
        if (currentBlock > lastProcessedBlock) {
          const fromBlock = lastProcessedBlock + BigInt(1);
          const toBlock = currentBlock;

          const createdLogs = await parentClient.getLogs({
            address: coreContracts.rollup as Address,
            fromBlock,
            toBlock,
            topics: [assertionCreatedTopic as any],
          } as any);

          for (const log of createdLogs) {
            let parsed;
            try {
              parsed = boldInterface.parseLog({
                topics: (log as any).topics,
                data: (log as any).data,
              });
            } catch {
              // Skip logs that don't match our ABI (e.g. other events from same contract)
              continue;
            }
            const args = parsed.args as any;
            const assertionHash = normalizeBytes32Like(args?.assertionHash ?? args?.[0]);
            const parentHash = normalizeBytes32Like(args?.parentAssertionHash ?? args?.[1]);

            logger.event(`New assertion created: Assertion ${assertionHash.slice(0, 18)}...`);
            logger.info(`  Hash: ${assertionHash}`);
            logger.info(`  Parent: ${parentHash}`);
            logger.txHash((log as any).transactionHash ?? '', 'AssertionCreated');

            // If requested, attempt to link this assertion to a specific L2->L1 message position.
            if (watchEnabled && watch && !firstCreatedContainingWatchedMessage) {
              const assertion = args?.assertion ?? args?.[2];
              const afterState = assertion?.afterState;
              const globalState = afterState?.globalState;
              const afterBlockHash = globalState?.bytes32Vals?.[0];
              const afterSendRoot = globalState?.bytes32Vals?.[1];

              if (afterBlockHash && afterSendRoot) {
                const blockHashNorm = normalizeBytes32Like(afterBlockHash);
                const sendRootNorm = normalizeBytes32Like(afterSendRoot);
                const sendInfo = await getArbBlockSendInfo(blockHashNorm);
                if (sendInfo && sendInfo.sendCount > watch.position) {
                  firstCreatedContainingWatchedMessage = {
                    assertionHash,
                    parentAssertionHash: parentHash,
                    blockHash: blockHashNorm,
                    sendRoot: sendRootNorm,
                    sendCount: sendInfo.sendCount,
                  };
                  logger.success(
                    `[Monitor] Assertion includes watched message position ${watch.position}${watchLabel}`,
                  );
                  logger.info(`  Assertion: ${assertionHash}`);
                  logger.info(`  SendRoot: ${sendRootNorm}`);
                  logger.info(`  BlockHash: ${blockHashNorm}`);
                  logger.info(`  SendCount: ${sendInfo.sendCount}`);
                }
              }
            }

            // Get assertion details
            try {
              const assertionInfo = (await parentClient.readContract({
                address: coreContracts.rollup as Address,
                abi: rollupCoreAbi,
                functionName: 'getAssertion',
                args: [assertionHash as `0x${string}`],
              })) as { status: number; createdAtBlock: bigint };

              const status = ['NoAssertion', 'Pending', 'Confirmed'][assertionInfo.status] || 'Unknown';
              logger.info(`  Status: ${status}`);
              logger.info(`  CreatedAtBlock: ${assertionInfo.createdAtBlock}`);

              monitorState.newAssertions.push({
                hash: assertionHash,
                parent: parentHash,
                block: assertionInfo.createdAtBlock,
              });
            } catch {
              // Assertion details fetch failed, continue
            }
          }

          // Also check for confirmed assertions
          const confirmedLogs = await parentClient.getLogs({
            address: coreContracts.rollup as Address,
            fromBlock,
            toBlock,
            topics: [assertionConfirmedTopic as any],
          } as any);

          for (const log of confirmedLogs) {
            let parsed;
            try {
              parsed = boldInterface.parseLog({
                topics: (log as any).topics,
                data: (log as any).data,
              });
            } catch {
              // Skip logs that don't match our ABI
              continue;
            }
            const args = parsed.args as any;
            const assertionHash = normalizeBytes32Like(args?.assertionHash ?? args?.[0]);
            const blockHash = normalizeBytes32Like(args?.blockHash ?? args?.[1]);
            const sendRoot = normalizeBytes32Like(args?.sendRoot ?? args?.[2]);
            const sendRootShort = sendRoot.length > 10 ? `${sendRoot.slice(0, 10)}...` : sendRoot;
            logger.event(`Assertion confirmed: ${assertionHash.slice(0, 18)}... | SendRoot: ${sendRootShort}`);
            logger.txHash((log as any).transactionHash ?? '', 'AssertionConfirmed');

            if (watchEnabled && watch && !firstConfirmedContainingWatchedMessage) {
              const sendInfo = await getArbBlockSendInfo(blockHash);
              if (sendInfo && sendInfo.sendCount > watch.position) {
                firstConfirmedContainingWatchedMessage = {
                  assertionHash,
                  blockHash,
                  sendRoot,
                  sendCount: sendInfo.sendCount,
                };
                logger.success(
                  `[Monitor] Confirmed assertion makes watched message executable (position ${watch.position}${watchLabel})`,
                );
                logger.info(`  Assertion: ${assertionHash}`);
                logger.info(`  SendRoot: ${sendRoot}`);
                logger.info(`  BlockHash: ${blockHash}`);
                logger.info(`  SendCount: ${sendInfo.sendCount}`);
                if (
                  firstCreatedContainingWatchedMessage &&
                  firstCreatedContainingWatchedMessage.assertionHash === assertionHash
                ) {
                  logger.info('  Note: this is the first AssertionCreated that already contained the message.');
                }
              }
            }
          }

          lastProcessedBlock = currentBlock;
        }

        // Update state
        monitorState.lastBatchCount = batchCount as bigint;
        monitorState.lastConfirmed = normalizeBytes32Like(latestConfirmed);
        monitorState.stakerCount = BigInt(stakerCount as number);

        // Log summary
        const confirmedStr = normalizeBytes32Like(latestConfirmed);
        const confirmedShort = confirmedStr.length > 10 ? `${confirmedStr.slice(0, 10)}...` : confirmedStr;
        logger.raw(`[Monitor] Batch: ${batchCount} | Confirmed: ${confirmedShort} | Stakers: ${stakerCount}`);
      } catch (err) {
        // Avoid log spam: print at most once per 60s.
        const now = Date.now();
        if (now - lastErrorLogMs > 60_000) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.debug(`[Monitor] Error: ${msg}`);
          lastErrorLogMs = now;
        }
      }

      await sleep(5000);
    }
  };

  // Run monitor in background (non-blocking)
  monitorLoop().catch(console.error);
}

/**
 * Stop the rollup monitor
 */
export function stopRollupMonitor(): void {
  monitorState.running = false;
  logger.info('[Monitor] Stopping background monitoring...');
}

/**
 * Get current monitor state
 */
export function getMonitorState(): MonitorState {
  return { ...monitorState };
}

/**
 * Wait for a new assertion to be confirmed
 *
 * @param parentClient - The parent chain public client
 * @param rollupAddress - The rollup contract address
 * @param currentConfirmed - The current latestConfirmed assertion hash
 * @param maxWaitSeconds - Maximum time to wait in seconds
 * @returns The new confirmed assertion hash, or null if timeout
 */
export async function waitForAssertionConfirmation(
  parentClient: PublicClient,
  rollupAddress: Address,
  currentConfirmed: string,
  maxWaitSeconds: number = 600,
  signal?: AbortSignal,
): Promise<string | null> {
  const intervalMs = 5000;
  const maxAttempts = Math.ceil((maxWaitSeconds * 1000) / intervalMs);
  let attempts = 0;

  logger.info(`Waiting for new assertion confirmation (max ${maxWaitSeconds}s)...`);

  while (attempts < maxAttempts) {
    await cancellableSleep(intervalMs, signal);
    attempts++;

    const newConfirmedRaw = await parentClient.readContract({
      address: rollupAddress,
      abi: rollupCoreAbi,
      functionName: 'latestConfirmed',
    });

    const currentConfirmedNorm = normalizeBytes32Like(currentConfirmed);
    const newConfirmedNorm = normalizeBytes32Like(newConfirmedRaw);

    if (newConfirmedNorm !== currentConfirmedNorm) {
      logger.success(`New assertion confirmed: ${newConfirmedNorm}`);
      return newConfirmedNorm;
    }

    if (attempts % 12 === 0) {
      // Log every 60 seconds
      logger.info(`Still waiting... (${(attempts * intervalMs) / 1000}s elapsed)`);
    }
  }

  logger.warn(`Timeout waiting for assertion confirmation after ${maxWaitSeconds}s`);
  return null;
}

/**
 * Get current rollup status
 */
export async function getRollupStatus(parentClient: PublicClient, coreContracts: CoreContracts): Promise<RollupStatus> {
  const [batchCount, latestConfirmed, stakerCount, confirmPeriodBlocks] = await Promise.all([
    parentClient.readContract({
      address: coreContracts.sequencerInbox as Address,
      abi: sequencerInboxAbi,
      functionName: 'batchCount',
    }),
    parentClient.readContract({
      address: coreContracts.rollup as Address,
      abi: rollupCoreAbi,
      functionName: 'latestConfirmed',
    }),
    parentClient.readContract({
      address: coreContracts.rollup as Address,
      abi: rollupCoreAbi,
      functionName: 'stakerCount',
    }),
    parentClient.readContract({
      address: coreContracts.rollup as Address,
      abi: rollupCoreAbi,
      functionName: 'confirmPeriodBlocks',
    }),
  ]);

  // latestConfirmed returns bytes32, convert to hex string if needed
  const latestConfirmedStr: string =
    typeof latestConfirmed === 'bigint'
      ? `0x${latestConfirmed.toString(16).padStart(64, '0')}`
      : String(latestConfirmed);

  return {
    batchCount: batchCount as bigint,
    latestConfirmed: latestConfirmedStr,
    stakerCount: BigInt(stakerCount as number),
    confirmPeriodBlocks: BigInt(confirmPeriodBlocks as number),
  };
}
