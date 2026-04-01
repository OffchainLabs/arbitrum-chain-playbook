/**
 * Challenge Runner
 *
 * Orchestrates the challenge demo flow using ReadInboxMessage bit-flip:
 * 1. Redeploy chain (confirmPeriodBlocks=1600)
 * 2. Generate and write node configs (malicious + honest)
 * 3. Start malicious node (DOCKER_IMAGE_MALICIOUS)
 * 4. Start honest node (DOCKER_IMAGE_HONEST)
 * 5. Send delayed messages (L1 deposits for non-linear bisection)
 * 6. Wait for delayed sequencer to include messages
 * 7. Send child chain transactions (trigger ReadInboxMessage divergence)
 * 8. Start challenge monitor & wait for EdgeConfirmedByOneStepProof
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  parseEther,
  type PublicClient,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as fs from 'fs';
import * as path from 'path';
import { getParentChain } from '../../utils/parentChain.js';
import { ChainEnv } from '../../state/chainEnv/index.js';
import { SendersEnv, SenderRole } from '../../state/sendersEnv/index.js';
import { NodeType, NodeStatus } from '../../types/index.js';
import {
  NODE_CONFIG_FILENAME,
  NODE_CONFIG_MALICIOUS_FILENAME,
  NODE_CONFIG_HONEST_FILENAME,
  CHALLENGE_CONFIRM_PERIOD_BLOCKS,
  DEFAULT_MAIN_NODE_HTTP_PORT,
  DOCKER_IMAGE_MALICIOUS,
} from '../../types/constants.js';
import logger from '../../utils/logger.js';
import { StepTracker } from '../../utils/ui.js';
import { type OperationContext, cancellableSleep } from '../../utils/cancellation.js';
import { deployChain } from '../../core/deployChain/deployChain.js';
import {
  overwriteToNodeConfigForMainNode,
  overwriteToNodeConfigForMaliciousValidator,
  overwriteToNodeConfigForHonestValidator,
} from '../../utils/nodeConfigUtils.js';
import { saveNodeConfigForType } from '../../state/chainEnv/persistence.js';
import { rollupCoreAbi, inboxAbi } from './abis.js';
import { type ChallengeDemoConfig, type ChallengeDemoResult, DEFAULT_CHALLENGE_DEMO_CONFIG } from './types.js';
import {
  startChallengeMonitor,
  stopChallengeMonitor,
  getChallengeState,
  waitForChallengeResolution,
  printChallengeSummary,
  reconstructBisectionPaths,
} from './challengeMonitor.js';

/**
 * Get the EdgeChallengeManager address from rollup
 */
async function getChallengeManagerAddress(parentClient: PublicClient, rollupAddress: Address): Promise<Address | null> {
  try {
    const address = await parentClient.readContract({
      address: rollupAddress,
      abi: rollupCoreAbi,
      functionName: 'challengeManager',
    });
    return address as Address;
  } catch (error) {
    logger.errorWithFix(
      `Failed to get challengeManager address: ${error}`,
      'Verify PARENT_CHAIN_RPC is reachable and the rollup address is correct.',
    );
    return null;
  }
}

/**
 * Get environment config for transactions
 */
function getEnvConfig(): {
  mainPrivateKey: `0x${string}`;
  parentChainRpc: string;
} {
  const sendersEnv = SendersEnv.getInstance();
  const mainSenders = sendersEnv.getAllByRole(SenderRole.RegularSender);
  if (mainSenders.length === 0) {
    throw new Error('No RegularSender account found. Please add a sender account first.');
  }
  return {
    mainPrivateKey: mainSenders[0].privateKey,
    parentChainRpc: process.env.PARENT_CHAIN_RPC || 'https://sepolia-rollup.arbitrum.io/rpc',
  };
}

/**
 * Get the child chain RPC URL from running nodes
 */
function getChildChainRpc(chainEnv: ChainEnv): string {
  const nodes = chainEnv.nodeManager?.getRunningNodes() ?? [];
  // Prefer malicious node (it's the sequencer), then main node
  const sequencerNode = nodes.find(
    (n) => n.config.nodeType === NodeType.MALICIOUS || n.config.nodeType === NodeType.MAIN,
  );
  if (sequencerNode?.config?.httpPort) {
    return `http://127.0.0.1:${sequencerNode.config.httpPort}`;
  }
  return `http://127.0.0.1:${DEFAULT_MAIN_NODE_HTTP_PORT}`;
}

/**
 * Verify that required nodes are still running.
 * Throws an error with actionable details if any node has crashed.
 */
async function ensureNodesRunning(
  nodeManager: {
    getRunningNodes(): { config: { id: string; nodeType?: string }; status: any; containerId?: string }[];
    checkNodeHealth?(nodeId: string): Promise<boolean>;
  },
  expectedNodeIds: string[],
): Promise<void> {
  for (const nodeId of expectedNodeIds) {
    const nodes = nodeManager.getRunningNodes();
    const node = nodes.find((n) => n.config.id === nodeId);

    if (!node || node.status !== NodeStatus.RUNNING) {
      // Double-check via docker inspect if available
      if (nodeManager.checkNodeHealth) {
        const healthy = await nodeManager.checkNodeHealth(nodeId);
        if (healthy) continue; // In-memory status stale, container is actually running
      }
      const containerId = (node as any)?.containerId ?? 'unknown';
      throw new Error(
        `Node "${nodeId}" is no longer running (container: ${containerId}). ` +
          `Check logs: docker logs ${containerId}`,
      );
    }

    // Also verify via docker inspect for more reliable status
    if (nodeManager.checkNodeHealth) {
      const healthy = await nodeManager.checkNodeHealth(nodeId);
      if (!healthy) {
        const containerId = (node as any)?.containerId ?? 'unknown';
        throw new Error(
          `Node "${nodeId}" container has exited (container: ${containerId}). ` +
            `Check logs: docker logs ${containerId}`,
        );
      }
    }
  }
}

/**
 * Sleep with periodic node health checks.
 * Throws if any node crashes during the wait.
 */
async function healthCheckedSleep(
  durationMs: number,
  nodeManager: {
    getRunningNodes(): { config: { id: string }; status: any; containerId?: string }[];
    checkNodeHealth?(nodeId: string): Promise<boolean>;
  },
  expectedNodeIds: string[],
  signal?: AbortSignal,
  checkIntervalMs: number = 10000,
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < durationMs) {
    if (signal?.aborted) throw new Error('Cancelled');
    const remaining = durationMs - (Date.now() - startTime);
    const sleepTime = Math.min(checkIntervalMs, remaining);
    await cancellableSleep(sleepTime, signal);
    await ensureNodesRunning(nodeManager, expectedNodeIds);
  }
}

/**
 * Run the challenge demo
 *
 * 8-step flow:
 * 1. Redeploy chain
 * 2. Generate and write node configs
 * 3. Start malicious node
 * 4. Start honest node
 * 5. Send delayed messages (L1 deposits)
 * 6. Wait for delayed sequencer
 * 7. Send child chain transactions
 * 8. Start challenge monitor & wait for resolution
 */
export async function runChallengeDemo(
  config: ChallengeDemoConfig = DEFAULT_CHALLENGE_DEMO_CONFIG,
  ctx?: OperationContext,
): Promise<ChallengeDemoResult> {
  const startTime = Date.now();
  logger.section('Challenge Demo');

  const chainEnv = ChainEnv.getInstance();
  const result: ChallengeDemoResult = {
    success: false,
    totalEdges: 0,
    totalBisections: 0,
    durationMs: 0,
    events: [],
    bisectionPaths: { block: [], bigStep: [], smallStep: [] },
  };

  const tracker = new StepTracker([
    'Redeploy chain',
    'Generate node configs',
    'Start malicious node',
    'Start honest node',
    'Send delayed messages',
    'Wait for delayed sequencer',
    'Send child chain transactions',
    'Monitor challenge',
  ]);

  ctx?.onCleanup(async () => tracker.fail('Cancelled'));

  // ========================================================================
  // Step 1: Redeploy Chain
  // ========================================================================
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Redeploy chain');
  tracker.start();

  // Stop all running nodes before redeployment
  const nodeManager = chainEnv.nodeManager;
  if (nodeManager) {
    const runningNodes = nodeManager.getRunningNodes();
    if (runningNodes.length > 0) {
      logger.info(`Stopping ${runningNodes.length} running node(s)...`);
      await nodeManager.stopAllNodes();
      logger.success('All nodes stopped.');
    }
  }

  // Deploy fresh chain with challenge-specific confirmPeriodBlocks
  logger.info(`Deploying chain with confirmPeriodBlocks=${CHALLENGE_CONFIRM_PERIOD_BLOCKS}...`);
  const parentChain = getParentChain();
  const deploySuccess = await deployChain(parentChain, ctx, {
    confirmPeriodBlocks: CHALLENGE_CONFIRM_PERIOD_BLOCKS,
    skipPrompts: true,
  });

  if (!deploySuccess) {
    tracker.fail();
    logger.errorWithFix('Chain deployment failed.', 'Check PARENT_CHAIN_RPC and MAIN_PRIVATE_KEY in .env file.');
    return result;
  }

  // Reload chain env after deployment
  if (!chainEnv.status.isInitiated()) {
    if (!chainEnv.load()) {
      tracker.fail();
      logger.errorWithFix(
        'Failed to load chain after deployment.',
        'Check that node-config.json was created successfully.',
      );
      return result;
    }
  }

  logger.success('Chain deployed successfully.');

  // Convert ETH to WETH for both validators (required for BoLD staking)
  {
    const coreContracts = chainEnv.chainConfig.getCoreContracts();
    if (coreContracts) {
      const envConfig = getEnvConfig();
      const parentChainForWeth = getParentChain();
      const parentClientForWeth = createPublicClient({
        chain: parentChainForWeth,
        transport: http(envConfig.parentChainRpc),
      });

      // Read stakeToken address from rollup contract
      const rollupAddr = coreContracts.rollup as Address;
      let stakeTokenAddress: Address | null = null;
      try {
        stakeTokenAddress = (await parentClientForWeth.readContract({
          address: rollupAddr,
          abi: rollupCoreAbi,
          functionName: 'stakeToken',
        })) as Address;
      } catch (error) {
        logger.warn(`Failed to read stakeToken from rollup: ${error}`);
      }

      if (stakeTokenAddress && stakeTokenAddress !== '0x0000000000000000000000000000000000000000') {
        const wethDepositAbi = [
          {
            inputs: [],
            name: 'deposit',
            outputs: [],
            stateMutability: 'payable',
            type: 'function',
          },
        ] as const;

        const sendersEnvForWeth = SendersEnv.getInstance();
        const validators = sendersEnvForWeth.getAllByRole(SenderRole.Validator);
        const wethAmount = parseEther('0.001');

        logger.info(
          `Converting 0.001 ETH to WETH for ${validators.length} validators (stakeToken: ${stakeTokenAddress})...`,
        );
        for (const validator of validators) {
          try {
            const wallet = createWalletClient({
              account: validator.signer,
              chain: parentChainForWeth,
              transport: http(envConfig.parentChainRpc),
            });
            const hash = await wallet.writeContract({
              address: stakeTokenAddress,
              abi: wethDepositAbi,
              functionName: 'deposit',
              value: wethAmount,
            });
            await parentClientForWeth.waitForTransactionReceipt({ hash });
            logger.success(`  ${validator.signer.address}: 0.001 ETH -> WETH (tx: ${hash.slice(0, 18)}...)`);
          } catch (error) {
            logger.warn(`  Failed WETH deposit for ${validator.signer.address}: ${error}`);
          }
        }

        // Approve EdgeChallengeManager to spend WETH for both validators
        let challengeManagerAddr: Address | null = null;
        try {
          challengeManagerAddr = (await parentClientForWeth.readContract({
            address: rollupAddr,
            abi: rollupCoreAbi,
            functionName: 'challengeManager',
          })) as Address;
        } catch (error) {
          logger.warn(`Failed to read challengeManager address: ${error}`);
        }

        if (challengeManagerAddr) {
          const erc20ApproveAbi = [
            {
              inputs: [
                { internalType: 'address', name: 'spender', type: 'address' },
                { internalType: 'uint256', name: 'amount', type: 'uint256' },
              ],
              name: 'approve',
              outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
              stateMutability: 'nonpayable',
              type: 'function',
            },
          ] as const;

          const maxApproval = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
          logger.info(`Approving EdgeChallengeManager (${challengeManagerAddr}) to spend WETH...`);
          for (const validator of validators) {
            try {
              const wallet = createWalletClient({
                account: validator.signer,
                chain: parentChainForWeth,
                transport: http(envConfig.parentChainRpc),
              });
              const hash = await wallet.writeContract({
                address: stakeTokenAddress,
                abi: erc20ApproveAbi,
                functionName: 'approve',
                args: [challengeManagerAddr, maxApproval],
              });
              await parentClientForWeth.waitForTransactionReceipt({ hash });
              logger.success(`  ${validator.signer.address}: approved (tx: ${hash.slice(0, 18)}...)`);
            } catch (error) {
              logger.warn(`  Failed approve for ${validator.signer.address}: ${error}`);
            }
          }
        }
      } else {
        logger.info('stakeToken is ETH (address(0)), skipping WETH conversion.');
      }
    }
  }

  ctx?.stepCompleted('Redeploy chain');

  // ========================================================================
  // Step 2: Generate and Write Node Configs
  // ========================================================================
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Generate node configs');
  tracker.start();

  const mainConfigPath = path.join(process.cwd(), NODE_CONFIG_FILENAME);
  if (!fs.existsSync(mainConfigPath)) {
    tracker.fail();
    logger.errorWithFix(
      'Main node config not found after deployment.',
      'This should not happen. Check deployment logs.',
    );
    return result;
  }

  // Read the base node config
  const baseNodeConfig = JSON.parse(fs.readFileSync(mainConfigPath, 'utf8'));

  // Generate malicious node config (will be started as MAIN — it's the sequencer)
  let maliciousConfig = JSON.parse(JSON.stringify(baseNodeConfig));
  maliciousConfig = overwriteToNodeConfigForMainNode(maliciousConfig);
  maliciousConfig = overwriteToNodeConfigForMaliciousValidator(maliciousConfig);
  saveNodeConfigForType(NodeType.MALICIOUS, maliciousConfig);
  logger.success(`Generated ${NODE_CONFIG_MALICIOUS_FILENAME}`);

  // Register malicious config as MAIN so nodeManager treats it as the sequencer
  chainEnv.nodeConfig.setPath(NodeType.MAIN, path.join(process.cwd(), NODE_CONFIG_MALICIOUS_FILENAME));

  // Generate honest node config with validator[1]'s private key
  const sendersEnv = SendersEnv.getInstance();
  const allValidators = sendersEnv.getAllByRole(SenderRole.Validator);
  if (allValidators.length < 2) {
    tracker.fail();
    logger.errorWithFix(
      'Two validator accounts required but only found ' + allValidators.length,
      'This should not happen after deployment. Check deployment logs.',
    );
    return result;
  }
  let honestConfig = JSON.parse(JSON.stringify(baseNodeConfig));
  // Set honest validator's private key (validator[1]) — baseNodeConfig has validator[0]'s key
  if (honestConfig.node?.staker?.['parent-chain-wallet']) {
    const rawKey = allValidators[1].privateKey.startsWith('0x')
      ? allValidators[1].privateKey.slice(2)
      : allValidators[1].privateKey;
    honestConfig.node.staker['parent-chain-wallet']['private-key'] = rawKey;
  }
  honestConfig = overwriteToNodeConfigForHonestValidator(honestConfig, DEFAULT_MAIN_NODE_HTTP_PORT);
  saveNodeConfigForType(NodeType.HONEST, honestConfig);
  logger.success(`Generated ${NODE_CONFIG_HONEST_FILENAME}`);
  logger.info(`  Malicious validator: ${allValidators[0].signer.address}`);
  logger.info(`  Honest validator:    ${allValidators[1].signer.address}`);

  chainEnv.nodeConfig.setPath(NodeType.HONEST, path.join(process.cwd(), NODE_CONFIG_HONEST_FILENAME));

  ctx?.stepCompleted('Generate node configs');

  // ========================================================================
  // Step 3: Start Malicious Node
  // ========================================================================
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Start malicious node');
  tracker.start();

  const updatedNodeManager = chainEnv.nodeManager;
  if (!updatedNodeManager) {
    tracker.fail();
    logger.errorWithFix(
      'NodeManager not available after deployment.',
      'This should not happen. Check deployment logs.',
    );
    return result;
  }

  logger.info('Starting malicious node (ReadInboxMessage bit-flip mode)...');
  const maliciousNode = await updatedNodeManager.startNode(NodeType.MAIN, { dockerImage: DOCKER_IMAGE_MALICIOUS });
  if (!maliciousNode) {
    tracker.fail();
    logger.errorWithFix(
      'Failed to start malicious node.',
      'Ensure Docker is running (`docker info`) and check Docker logs for details.',
    );
    return result;
  }
  ctx?.onCleanup(async () => {
    logger.info('Stopping malicious node...');
    await updatedNodeManager.stopNode(maliciousNode.config.id);
  });

  logger.info('Waiting for malicious node to be ready...');
  await cancellableSleep(10000, ctx?.signal);

  // Verify malicious node survived startup
  await ensureNodesRunning(updatedNodeManager, [maliciousNode.config.id]);
  logger.success('Malicious node started.');

  ctx?.stepCompleted('Start malicious node');

  // ========================================================================
  // Step 4: Start Honest Node
  // ========================================================================
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Start honest node');
  tracker.start();

  logger.info('Starting honest validator node...');
  const honestNode = await updatedNodeManager.startNode(NodeType.HONEST);
  if (!honestNode) {
    tracker.fail();
    logger.errorWithFix(
      'Failed to start honest validator node.',
      'Ensure Docker is running and the honest config is valid.',
    );
    return result;
  }
  ctx?.onCleanup(async () => {
    logger.info('Stopping honest validator node...');
    await updatedNodeManager.stopNode(honestNode.config.id);
  });

  logger.info('Waiting for honest validator to sync...');
  await cancellableSleep(15000, ctx?.signal);

  // Verify both nodes survived startup
  await ensureNodesRunning(updatedNodeManager, [maliciousNode.config.id, honestNode.config.id]);
  logger.success('Both nodes running. Honest validator synced.');
  ctx?.stepCompleted('Start honest node');

  // Track expected running nodes for health checks in subsequent steps
  const activeNodeIds = [maliciousNode.config.id, honestNode.config.id];

  // ========================================================================
  // Step 5: Send Delayed Messages (L1 Deposits for Non-Linear Bisection)
  // ========================================================================
  ctx?.throwIfCancelled();
  await ensureNodesRunning(updatedNodeManager, activeNodeIds);
  ctx?.stepStarted('Send delayed messages');
  tracker.start();

  const coreContracts = chainEnv.chainConfig.getCoreContracts();
  if (!coreContracts) {
    tracker.fail();
    logger.errorWithFix('Core contracts not available.', 'Chain deployment may have partially failed.');
    return result;
  }

  const envConfig = getEnvConfig();
  const mainAccount = privateKeyToAccount(envConfig.mainPrivateKey);
  const parentChainForClient = getParentChain();

  const parentClient = createPublicClient({
    chain: parentChainForClient,
    transport: http(envConfig.parentChainRpc),
  });

  const parentWallet = createWalletClient({
    account: mainAccount,
    chain: parentChainForClient,
    transport: http(envConfig.parentChainRpc),
  });

  logger.info(
    `Sending ${config.delayedMessageCount} delayed messages (depositEth) to create agreed execution prefix...`,
  );

  const inboxAddress = coreContracts.inbox as Address;
  let successCount = 0;

  for (let i = 0; i < config.delayedMessageCount; i++) {
    ctx?.throwIfCancelled();
    try {
      const hash = await parentWallet.writeContract({
        address: inboxAddress,
        abi: inboxAbi,
        functionName: 'depositEth',
        value: config.delayedMessageAmount,
      });
      successCount++;
      if ((i + 1) % 10 === 0 || i === config.delayedMessageCount - 1) {
        logger.info(`  Delayed messages sent: ${i + 1}/${config.delayedMessageCount} (tx: ${hash.slice(0, 18)}...)`);
      }
    } catch (error) {
      logger.debug(`Failed to send delayed message ${i + 1}: ${error}`);
    }
  }

  if (successCount === 0) {
    tracker.fail();
    logger.errorWithFix(
      'Failed to send any delayed messages.',
      'Check MAIN_PRIVATE_KEY balance and PARENT_CHAIN_RPC connectivity.',
    );
    return result;
  }

  logger.success(`Sent ${successCount}/${config.delayedMessageCount} delayed messages.`);
  ctx?.stepCompleted('Send delayed messages');

  // ========================================================================
  // Step 6: Wait for Delayed Sequencer
  // ========================================================================
  ctx?.throwIfCancelled();
  await ensureNodesRunning(updatedNodeManager, activeNodeIds);
  ctx?.stepStarted('Wait for delayed sequencer');
  tracker.start();

  logger.info('Waiting ~60s for the delayed sequencer to include messages (checking node health every 10s)...');
  await healthCheckedSleep(60000, updatedNodeManager, activeNodeIds, ctx?.signal);
  logger.success('Delayed sequencer wait complete.');

  ctx?.stepCompleted('Wait for delayed sequencer');

  // ========================================================================
  // Step 7: Send Child Chain Transactions (Trigger ReadInboxMessage Divergence)
  // ========================================================================
  ctx?.throwIfCancelled();
  await ensureNodesRunning(updatedNodeManager, activeNodeIds);
  ctx?.stepStarted('Send child chain transactions');
  tracker.start();

  const childChainRpc = getChildChainRpc(chainEnv);
  const chainConfig = chainEnv.chainConfig.get();
  const childChainId = chainConfig?.chainId;

  if (!childChainId) {
    tracker.fail();
    logger.errorWithFix('Chain ID not available.', 'Chain deployment may have failed.');
    return result;
  }

  const childChain = defineChain({
    id: childChainId,
    name: 'Child Chain',
    network: 'child-chain',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: {
      default: { http: [childChainRpc] },
      public: { http: [childChainRpc] },
    },
  });

  const childWallet = createWalletClient({
    account: mainAccount,
    chain: childChain,
    transport: http(childChainRpc),
  });

  logger.info(`Sending ${config.childChainTxCount} L2 transactions to trigger ReadInboxMessage divergence...`);

  let l2TxCount = 0;
  for (let i = 0; i < config.childChainTxCount; i++) {
    ctx?.throwIfCancelled();
    try {
      const hash = await childWallet.sendTransaction({
        to: mainAccount.address,
        value: BigInt(1), // minimal self-transfer
      });
      l2TxCount++;
      logger.info(`  L2 tx ${i + 1}/${config.childChainTxCount}: ${hash.slice(0, 18)}...`);
      // Wait 3s between transactions
      if (i < config.childChainTxCount - 1) {
        await cancellableSleep(3000, ctx?.signal);
      }
    } catch (error) {
      logger.debug(`Failed to send L2 tx ${i + 1}: ${error}`);
    }
  }

  if (l2TxCount === 0) {
    logger.warn('Failed to send any L2 transactions. The batch poster may still create batches from delayed messages.');
  } else {
    logger.success(`Sent ${l2TxCount}/${config.childChainTxCount} L2 transactions.`);
  }

  logger.info('Waiting for batch poster to batch transactions...');
  await healthCheckedSleep(15000, updatedNodeManager, activeNodeIds, ctx?.signal);

  ctx?.stepCompleted('Send child chain transactions');

  // ========================================================================
  // Step 8: Start Challenge Monitor & Wait for Resolution
  // ========================================================================
  ctx?.throwIfCancelled();
  await ensureNodesRunning(updatedNodeManager, activeNodeIds);
  ctx?.stepStarted('Monitor challenge');
  tracker.start();

  const rollupAddress = coreContracts.rollup as Address;
  const challengeManagerAddress = await getChallengeManagerAddress(parentClient, rollupAddress);

  if (!challengeManagerAddress) {
    tracker.fail();
    logger.errorWithFix(
      'Failed to get EdgeChallengeManager address from rollup contract.',
      'Verify that PARENT_CHAIN_RPC is correct and the rollup contract is accessible.',
    );
    return result;
  }

  logger.info(`Rollup: ${rollupAddress}`);
  logger.info(`ChallengeManager: ${challengeManagerAddress}`);

  await startChallengeMonitor(parentClient, challengeManagerAddress, config.pollIntervalMs);
  ctx?.onCleanup(async () => stopChallengeMonitor());

  tracker.complete('Challenge monitoring started');
  ctx?.stepCompleted('Monitor challenge');

  const maxWaitMin = Math.floor(config.maxWaitSeconds / 60);
  logger.info(`Monitoring for challenge activity (max ${maxWaitMin} min)...`);
  logger.newline();
  logger.raw('='.repeat(60));
  logger.raw('Challenge Progress (events will appear below):');
  logger.raw('='.repeat(60));
  logger.newline();

  // Wait for challenge to complete
  const confirmedEdgeId = await waitForChallengeResolution(config.maxWaitSeconds, ctx?.signal);

  // Stop monitor
  stopChallengeMonitor();

  // ========================================================================
  // Result Summary
  // ========================================================================
  logger.newline();
  logger.raw('='.repeat(60));

  const state = getChallengeState();
  result.totalEdges = state.totalEdgesCreated;
  result.totalBisections = state.totalBisections;
  result.events = state.events;
  result.durationMs = Date.now() - startTime;

  if (confirmedEdgeId) {
    result.success = true;
    result.confirmedEdgeId = confirmedEdgeId;
    result.winner = 'honest';
    result.bisectionPaths = reconstructBisectionPaths();

    // Find OSP tx hash
    const ospEvent = state.events.find((e) => e.type === 'edge_confirmed_osp' && e.edgeId === confirmedEdgeId);
    if (ospEvent?.txHash) {
      result.ospTxHash = ospEvent.txHash;
    }

    logger.event('Challenge resolved: honest validator validated');
    logger.success('Challenge completed!');
  } else if (state.totalEdgesCreated > 0) {
    result.winner = 'timeout';
    logger.warn('Challenge in progress but not yet resolved.');
    logger.info('The honest validator is still working on the challenge.');
  } else {
    result.winner = 'timeout';
    logger.warn('No challenge detected within the monitoring period.');
    logger.raw('  Possible causes:');
    logger.raw('    - The malicious node has not produced a divergent assertion yet');
    logger.raw('    - The honest validator is still syncing');
    logger.raw('    - The batch poster has not created batches yet');
    logger.raw(
      '  How to fix: Check validator logs with `docker logs <container_id>` and try increasing maxWaitSeconds.',
    );
  }

  // Print detailed summary (includes bisection paths if resolved)
  printChallengeSummary();

  // Final status
  logger.section('Demo Complete');
  const durationMin = Math.floor(result.durationMs / 60000);
  const durationSec = Math.floor((result.durationMs % 60000) / 1000);
  logger.raw(`  Duration: ${durationMin}m ${durationSec}s`);
  logger.raw(`  Total edges: ${result.totalEdges}`);
  logger.raw(`  Total bisections: ${result.totalBisections}`);
  logger.raw(`  Challenge events: ${result.events.length}`);

  if (result.success) {
    logger.newline();
    logger.success('The honest validator successfully defended against the malicious assertion!');
    logger.info('This demonstrates how BoLD protocol protects the chain via interactive challenge.');
    logger.newline();
    logger.info(
      `To visualize this challenge, copy the EdgeChallengeManager address below and paste it into the dashboard:`,
    );
    logger.info(`  EdgeChallengeManager: ${challengeManagerAddress}`);
    logger.info(`  Dashboard: https://offchainlabs.github.io/fraudproof-example-dashboard/edge-challenge-flow.html`);
  } else {
    logger.newline();
    logger.info('Challenge is still in progress. You can:');
    logger.info('  1. Wait longer for the challenge to complete');
    logger.info('  2. Use "View Rollup Status" to monitor progress');
    logger.info('  3. Check the EdgeChallengeManager for active edges');
  }

  return result;
}
