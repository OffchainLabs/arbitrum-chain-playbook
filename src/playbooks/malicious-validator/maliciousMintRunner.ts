/**
 * Malicious Mint Runner
 *
 * Core demo logic for the malicious minting and withdrawal flow.
 * Adapted from scripts/maliciousMintAndWithdraw.ts to use the playbook architecture.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  decodeEventLog,
  type PublicClient,
  type WalletClient,
  type Address,
  defineChain,
  type Chain,
  type Hash,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { getParentChain } from '../../utils/parentChain.js';
import { providers, Wallet } from 'ethers';
import { ChildTransactionReceipt, ChildToParentMessageStatus } from '@arbitrum/sdk';
import type { CoreContracts } from '@arbitrum/chain-sdk';
import { ChainEnv } from '../../state/chainEnv/index.js';
import { NodeType } from '../../types/index.js';
import {
  NODE_CONFIG_FILENAME,
  DEFAULT_MAIN_NODE_HTTP_PORT,
  MALICIOUS_MINT_CONFIRM_PERIOD_BLOCKS,
  DOCKER_IMAGE_MALICIOUS_ARBMINTER,
} from '../../types/constants.js';
import logger from '../../utils/logger.js';
import { overwriteNodeConfigFile } from '../../core/nodeConfig/nodeConfigOperations.js';
import { StepTracker } from '../../utils/ui.js';
import { type OperationContext, cancellableSleep } from '../../utils/cancellation.js';
import { getMainSenderPrivateKey, getParentChainRpcUrl, redeployFreshChain } from '../runnerKit.js';
import { inboxAbi, arbMinterAbi, arbSysAbi, rollupCoreAbi } from './abis.js';
import { type MaliciousMintConfig, type MaliciousMintResult, ARB_SYS_ADDRESS, ARB_MINTER_ADDRESS } from './types.js';
import { startRollupMonitor, stopRollupMonitor } from './monitor.js';
import { ensureCustomNetworkRegistered } from '../../utils/arbitrumSdkSetup.js';
import { normalizeBytes32Like } from '../../utils/bytes32.js';

/**
 * Wait for balance to reach a minimum threshold
 */
async function waitForBalance(
  client: PublicClient,
  address: Address,
  minBalance: bigint,
  maxAttempts: number = 60,
  intervalMs: number = 2000,
  signal?: AbortSignal,
): Promise<bigint> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const balance = await client.getBalance({ address });
      if (balance >= minBalance) {
        return balance;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(`[waitForBalance] RPC error (attempt ${i + 1}/${maxAttempts}): ${msg}`);
    }
    await cancellableSleep(intervalMs, signal);
  }
  throw new Error(`Timeout waiting for balance >= ${formatEther(minBalance)} ETH at ${address}`);
}

/**
 * Get configuration from playbook environment
 */
function getEnvConfig(): {
  mainPrivateKey: `0x${string}`;
  parentChainRpc: string;
  chainRpc: string;
  coreContracts: CoreContracts;
  chainId: number;
  parentChainId: number;
} {
  const chainEnv = ChainEnv.getInstance();

  // Get chain config
  const chainConfig = chainEnv.chainConfig.get();
  if (!chainConfig) {
    throw new Error('Chain configuration not available. Please deploy a chain first.');
  }

  // Get core contracts
  const coreContracts = chainEnv.chainConfig.getCoreContracts();
  if (!coreContracts) {
    throw new Error('Core contracts not available. Please deploy a chain first.');
  }

  const mainPrivateKey = getMainSenderPrivateKey();
  const parentChainRpc = getParentChainRpcUrl();

  // Get chain RPC URL from running node
  // Note: The port in config file is the container's internal port.
  // The actual host port is assigned dynamically by findAvailablePorts when starting the node.
  // So we must get the port from running node, not from config file.
  let chainRpc: string;
  const nodes = chainEnv.nodeManager?.getRunningNodes() ?? [];
  const mainNode = nodes.find((n) => n.config.nodeType === NodeType.MAIN);
  if (mainNode && mainNode.config?.httpPort) {
    // Use the actual host port from the running node
    chainRpc = `http://127.0.0.1:${mainNode.config.httpPort}`;
  } else {
    // No main node running - use default port as fallback
    // The caller should ensure the node is running before calling this
    chainRpc = `http://127.0.0.1:${DEFAULT_MAIN_NODE_HTTP_PORT}`;
    logger.warn(`No running main node found. Using default port ${DEFAULT_MAIN_NODE_HTTP_PORT}.`);
    logger.warn('Please start a node first using "Start Malicious Node" or "Run Challenge Demo".');
  }

  return {
    mainPrivateKey,
    parentChainRpc,
    chainRpc,
    coreContracts: coreContracts as CoreContracts,
    chainId: chainConfig.chainId,
    parentChainId: getParentChain().id,
  };
}

/** Decoded fields of the ArbSys `L2ToL1Tx` event needed to execute a withdrawal on L1. */
type L2ToL1TxData = {
  caller: Address;
  destination: Address;
  hash: bigint;
  position: bigint;
  arbBlockNum: bigint;
  ethBlockNum: bigint;
  timestamp: bigint;
  callvalue: bigint;
  data: `0x${string}`;
};

/**
 * Find and decode the `L2ToL1Tx` event among the logs ArbSys emitted for a
 * withdrawal. Returns null if it isn't present. Best-effort: also logs the
 * withdrawal block's Arbitrum-specific sendRoot/sendCount when the node exposes
 * them (used later to correlate the message position to the assertion sendRoot).
 */
async function parseL2ToL1TxData(
  withdrawReceipt: TransactionReceipt,
  childClient: PublicClient,
): Promise<L2ToL1TxData | null> {
  let l2ToL1TxData: L2ToL1TxData | null = null;

  // Find and decode L2ToL1Tx event from all logs emitted by ArbSys
  const arbSysLogs = withdrawReceipt.logs.filter((log) => log.address.toLowerCase() === ARB_SYS_ADDRESS.toLowerCase());

  for (const log of arbSysLogs) {
    try {
      // Use arbSysAbi (the complete ABI from SDK) to decode events
      const decoded = decodeEventLog({
        abi: arbSysAbi,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'L2ToL1Tx') {
        logger.success('L2ToL1Tx event detected');
        // Type assertion needed because viem's decodeEventLog returns union type
        const args = decoded.args as L2ToL1TxData;
        l2ToL1TxData = {
          caller: args.caller,
          destination: args.destination,
          hash: args.hash,
          position: args.position,
          arbBlockNum: args.arbBlockNum,
          ethBlockNum: args.ethBlockNum,
          timestamp: args.timestamp,
          callvalue: args.callvalue,
          data: args.data,
        };
        logger.info(`  Position (index): ${l2ToL1TxData.position}`);
        logger.info(`  L2 Block: ${l2ToL1TxData.arbBlockNum}`);
        logger.info(`  Value: ${formatEther(l2ToL1TxData.callvalue)} ETH`);
        break; // Found the L2ToL1Tx event, stop searching
      }
    } catch {
      // This log is not L2ToL1Tx, continue to next log
      continue;
    }
  }

  if (!l2ToL1TxData) {
    logger.warn('L2ToL1Tx event not found in logs');
    logger.info(`  Total logs from ArbSys: ${arbSysLogs.length}`);
  } else {
    // Best-effort: fetch Arbitrum-specific sendRoot/sendCount from the withdrawal block.
    // This helps us later correlate the outgoing message position to the rollup assertion sendRoot.
    try {
      const request = (childClient as any).request ?? (childClient as any).transport?.request;
      if (request) {
        const blockNumberHex = `0x${l2ToL1TxData.arbBlockNum.toString(16)}`;
        const block = await request({
          method: 'eth_getBlockByNumber',
          params: [blockNumberHex, false],
        });
        const sendRoot = (block as any)?.sendRoot as string | undefined;
        const sendCount = (block as any)?.sendCount as string | undefined;
        if (sendRoot && sendCount) {
          const sendRootNorm = normalizeBytes32Like(sendRoot);
          const sendCountBi = BigInt(sendCount);
          logger.info(`  L2 block sendRoot: ${sendRootNorm}`);
          logger.info(`  L2 block sendCount: ${sendCountBi} (message position: ${l2ToL1TxData.position})`);
        }
      }
    } catch {
      // Ignore - not all nodes expose Arbitrum-specific block fields
    }
  }

  return l2ToL1TxData;
}

/**
 * Once the withdrawal has been initiated on L2, either execute it on L1 (when
 * the challenge period is short enough to wait out) or note that manual
 * execution will be needed later. Returns the execution outcome for the summary.
 */
async function executeOrPollWithdrawal(params: {
  confirmPeriodBlocks: bigint;
  envConfig: ReturnType<typeof getEnvConfig>;
  hackerPrivateKey: `0x${string}`;
  hackerAddress: Address;
  withdrawTx: Hash;
  parentClient: PublicClient;
  ctx?: OperationContext;
}): Promise<{
  withdrawalExecuted: boolean;
  withdrawalTxHash: Hash | null;
  withdrawalExecutionError: string | null;
}> {
  const { confirmPeriodBlocks, envConfig, hackerPrivateKey, hackerAddress, withdrawTx, parentClient, ctx } = params;

  let withdrawalExecuted = false;
  let withdrawalExecutionError: string | null = null;
  let withdrawalTxHash: Hash | null = null;

  if (confirmPeriodBlocks < BigInt(20)) {
    logger.info('confirmPeriodBlocks < 20, polling for withdrawal message status...');

    // Ensure custom network is registered with the SDK
    ensureCustomNetworkRegistered(envConfig.chainId, envConfig.parentChainId, envConfig.coreContracts);

    // Execute withdrawal on L1 using @arbitrum/sdk
    logger.info('Preparing to execute withdrawal on L1 using Arbitrum SDK...');

    try {
      // Create ethers providers for SDK
      const parentChainProvider = new providers.JsonRpcProvider(envConfig.parentChainRpc);
      const childChainProvider = new providers.JsonRpcProvider(envConfig.chainRpc);

      // Create wallet for B using ethers
      const parentWalletHacker = new Wallet(hackerPrivateKey, parentChainProvider);

      // Get the withdrawal transaction receipt and wrap it with SDK
      const receipt = await childChainProvider.getTransactionReceipt(withdrawTx);
      const childTransactionReceipt = new ChildTransactionReceipt(receipt);

      // Get child-to-parent messages from the receipt
      const messages = await childTransactionReceipt.getChildToParentMessages(parentWalletHacker);

      if (messages.length === 0) {
        throw new Error('No child-to-parent messages found in transaction');
      }

      const childToParentMessage = messages[0];
      logger.info(`Found ${messages.length} child-to-parent message(s)`);

      // Check initial message status
      const initialStatus = await childToParentMessage.status(childChainProvider);
      logger.info(`Initial message status: ${ChildToParentMessageStatus[initialStatus]}`);

      if (initialStatus === ChildToParentMessageStatus.EXECUTED) {
        logger.warn('Message already executed!');
        withdrawalExecuted = true;
      } else if (initialStatus === ChildToParentMessageStatus.CONFIRMED) {
        // Execute the withdrawal immediately
        logger.info('Message is CONFIRMED. Executing withdrawal transaction...');
        const executeTransaction = await childToParentMessage.execute(childChainProvider);
        const executeReceipt = await executeTransaction.wait();

        withdrawalExecuted = true;
        withdrawalTxHash = executeReceipt.transactionHash as Hash;
        logger.txHash(withdrawalTxHash, 'executeTransaction', 'success');
        logger.event('Withdrawal executed successfully on L1!');

        // Check Hacker's balance on L1
        const hackerL1Balance = await parentClient.getBalance({ address: hackerAddress });
        logger.success(`Hacker's L1 balance: ${formatEther(hackerL1Balance)} ETH`);
      } else {
        // Status is UNCONFIRMED - poll until the message becomes CONFIRMED or EXECUTED
        // Monitor is already showing assertion progress in the background
        logger.warn(`Message not yet confirmed (status: ${ChildToParentMessageStatus[initialStatus]})`);
        logger.info('Polling for outbox entry every 30s (max 10 min)...');
        logger.info('(Monitor is showing assertion progress in the background)');

        const pollIntervalMs = 30_000; // 30 seconds
        const maxPollAttempts = 20; // 20 * 30s = 10 min max
        let pollAttempt = 0;
        let messageReady = false;

        while (pollAttempt < maxPollAttempts && !messageReady) {
          await cancellableSleep(pollIntervalMs, ctx?.signal);
          pollAttempt++;

          try {
            const currentStatus = await childToParentMessage.status(childChainProvider);
            const statusName = ChildToParentMessageStatus[currentStatus];
            const elapsed = pollAttempt * 30;
            logger.info(`[Poll ${pollAttempt}/${maxPollAttempts}] Message status: ${statusName} (${elapsed}s elapsed)`);

            if (currentStatus === ChildToParentMessageStatus.CONFIRMED) {
              messageReady = true;
              logger.success('Outbox entry exists! Executing now...');

              const executeTransaction = await childToParentMessage.execute(childChainProvider);
              const executeReceipt = await executeTransaction.wait();

              withdrawalExecuted = true;
              withdrawalTxHash = executeReceipt.transactionHash as Hash;
              logger.txHash(withdrawalTxHash, 'executeTransaction', 'success');
              logger.event('Withdrawal executed successfully on L1!');

              // Check B's balance on L1
              const hackerL1Balance = await parentClient.getBalance({ address: hackerAddress });
              logger.success(`Hacker's L1 balance: ${formatEther(hackerL1Balance)} ETH`);
            } else if (currentStatus === ChildToParentMessageStatus.EXECUTED) {
              messageReady = true;
              logger.warn('Message was already executed!');
              withdrawalExecuted = true;
            }
          } catch (pollErr) {
            const errMsg = pollErr instanceof Error ? pollErr.message : String(pollErr);
            logger.debug(`Poll error: ${errMsg}`);
            // Continue polling - transient errors are expected
          }
        }

        if (!messageReady) {
          logger.warn('Timeout: message still not ready after 10 minutes of polling.');
          logger.raw(
            '  How to fix: The challenge period may be longer than expected. Try executing the withdrawal manually later.',
          );
          withdrawalExecutionError = 'Message not ready for execution within timeout';
        }
      }
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      logger.errorWithFix(
        `Failed to execute withdrawal: ${errorMsg}`,
        'The withdrawal may need to be executed manually via Outbox.executeTransaction() after the challenge period.',
      );
      withdrawalExecutionError = errorMsg;
    }
  } else {
    logger.warn(`confirmPeriodBlocks (${confirmPeriodBlocks}) >= 20, challenge period is long.`);
    logger.warn('Manual execution on L1 will be required after the challenge period.');
    logger.info('Monitoring for 60 seconds...');
    await cancellableSleep(60000, ctx?.signal);
  }

  return { withdrawalExecuted, withdrawalTxHash, withdrawalExecutionError };
}

/**
 * Run the malicious mint demo
 *
 * This function performs the following steps:
 * 1. Redeploy chain (confirmPeriodBlocks=20)
 * 2. Start node (malicious ArbMinter image)
 * 3. Check parent chain bridge balance
 * 4. MAIN account deposits ETH to child chain
 * 5. Generate random account B, fund it, and deposit
 * 6. Wait for funds on child chain
 * 7. B calls ArbMinter.mintBalanceTo (malicious minting)
 * 8. B calls ArbSys.withdrawEth to withdraw minted funds
 * 9. Check confirmPeriodBlocks and start monitor
 * 10. Wait for withdrawal to be ready (if short challenge period)
 * 11. Check final bridge balance
 */
export async function runMaliciousMintDemo(
  config: MaliciousMintConfig,
  ctx?: OperationContext,
): Promise<MaliciousMintResult> {
  logger.section('Malicious Mint Demo');

  const chainEnv = ChainEnv.getInstance();

  const tracker = new StepTracker([
    'Redeploy chain',
    'Start node',
    'Checking bridge balance',
    `Depositing ${formatEther(config.mainDepositAmount)} ETH from MAIN account`,
    'Generating and funding Hacker account',
    'Waiting for funds on child chain',
    'Hacker minting via ArbMinter',
    'Hacker withdrawing via ArbSys',
    'Starting rollup monitor',
    'Waiting for withdrawal readiness',
    'Final bridge balance check',
  ]);

  ctx?.onCleanup(async () => tracker.fail('Cancelled'));

  // Reused for every early-exit failure path below.
  const failureResult: MaliciousMintResult = {
    success: false,
    mainAddress: '0x0' as Address,
    hackerAddress: '0x0' as Address,
    hackerPrivateKey: '0x0' as `0x${string}`,
    mintAmount: 0n,
    withdrawAmount: 0n,
    confirmPeriodBlocks: 0n,
    bridgeBalanceInitial: 0n,
    bridgeBalanceFinal: 0n,
  };

  // ========================================================================
  // Step 1: Redeploy Chain
  // ========================================================================
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Redeploy chain');
  tracker.start();

  if (!(await redeployFreshChain(MALICIOUS_MINT_CONFIRM_PERIOD_BLOCKS, ctx))) {
    tracker.fail();
    return failureResult;
  }

  // Apply malicious mint config flags to node-config.json before starting
  // (fast-validator, fast-batch-poster, ignore-rollup-wasm-module-root, block-validator with local WASM)
  logger.info('Applying malicious mint config flags...');
  await overwriteNodeConfigFile('malicious-mint', NODE_CONFIG_FILENAME);
  await overwriteNodeConfigFile('deleting-bold-strategy', NODE_CONFIG_FILENAME);
  logger.success('Config flags applied (malicious-mint, deleting-bold-strategy).');

  ctx?.stepCompleted('Redeploy chain');

  // ========================================================================
  // Step 2: Start Node
  // ========================================================================
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Start node');
  tracker.start();

  const nodeManager = chainEnv.nodeManager;
  if (!nodeManager) {
    tracker.fail();
    logger.errorWithFix(
      'NodeManager not available after deployment.',
      'This should not happen. Check deployment logs.',
    );
    return failureResult;
  }

  logger.info('Starting node (malicious ArbMinter image)...');
  const node = await nodeManager.startNode(NodeType.MAIN, { dockerImage: DOCKER_IMAGE_MALICIOUS_ARBMINTER });
  if (!node) {
    tracker.fail();
    logger.errorWithFix(
      'Failed to start node.',
      'Ensure Docker is running (`docker info`) and check Docker logs for details.',
    );
    return failureResult;
  }
  ctx?.onCleanup(async () => {
    logger.info('Stopping node...');
    await nodeManager.stopNode(node.config.id);
  });

  logger.info('Waiting for node to be ready...');
  await cancellableSleep(10000, ctx?.signal);

  // Verify node survived startup
  if (nodeManager.checkNodeHealth) {
    const healthy = await nodeManager.checkNodeHealth(node.config.id);
    if (!healthy) {
      tracker.fail();
      const containerId = (node as any)?.containerId ?? 'unknown';
      logger.errorWithFix(
        `Node exited unexpectedly (container: ${containerId}).`,
        `Check logs: docker logs ${containerId}`,
      );
      return failureResult;
    }
  }

  logger.success('Node started.');
  ctx?.stepCompleted('Start node');

  // Now get env config (requires running node for RPC port)
  const envConfig = getEnvConfig();
  const mainAccount = privateKeyToAccount(envConfig.mainPrivateKey);
  const coreContracts = envConfig.coreContracts;

  logger.info(`Main account: ${mainAccount.address}`);

  // Create parent chain client
  const parentClient = createPublicClient({
    chain: getParentChain(),
    transport: http(envConfig.parentChainRpc),
  });

  const parentWalletMain = createWalletClient({
    account: mainAccount,
    chain: getParentChain(),
    transport: http(envConfig.parentChainRpc),
  });

  // ========================================================================
  // Step 1: Check bridge balance
  // ========================================================================
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Checking bridge balance');
  tracker.start();

  const bridgeBalanceInitial = await parentClient.getBalance({
    address: coreContracts.bridge as Address,
  });
  logger.info(`Bridge: ${coreContracts.bridge}`);
  logger.success(`Bridge initial balance: ${formatEther(bridgeBalanceInitial)} ETH`);

  // Define child chain
  const childChain = defineChain({
    id: envConfig.chainId,
    name: 'Custom Arbitrum Chain',
    network: 'custom-arbitrum',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: {
      default: { http: [envConfig.chainRpc] },
      public: { http: [envConfig.chainRpc] },
    },
  });

  // Create child chain clients
  const childClient = createPublicClient({
    chain: childChain,
    transport: http(envConfig.chainRpc),
  });

  const childWalletMain = createWalletClient({
    account: mainAccount,
    chain: childChain,
    transport: http(envConfig.chainRpc),
  });

  ctx?.stepCompleted('Checking bridge balance');

  // ========================================================================
  // Step 2: MAIN account deposits ETH
  // ========================================================================
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Depositing ETH from MAIN account');
  tracker.start();

  const mainBalanceBefore = await childClient.getBalance({ address: mainAccount.address });
  logger.info(`MAIN L2 balance before: ${formatEther(mainBalanceBefore)} ETH`);

  const depositTxMain = await parentWalletMain.writeContract({
    address: coreContracts.inbox as Address,
    abi: inboxAbi,
    functionName: 'depositEth',
    value: config.mainDepositAmount,
    chain: getParentChain(),
    account: mainAccount,
  });

  await parentClient.waitForTransactionReceipt({ hash: depositTxMain });
  logger.txHash(depositTxMain, 'depositEth', 'success');
  logger.success('Deposit confirmed on parent chain');

  ctx?.stepCompleted('Depositing ETH from MAIN account');

  // ========================================================================
  // Step 3: Generate random Hacker account, fund it, and deposit
  // ========================================================================
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Generating and funding Hacker account');
  tracker.start();

  const hackerPrivateKey = generatePrivateKey();
  const hackerAccount = privateKeyToAccount(hackerPrivateKey);
  logger.info(`Hacker address: ${hackerAccount.address}`);
  logger.info(`Hacker private key: ${hackerPrivateKey}`);

  // MAIN sends ETH to Hacker on parent chain for gas
  logger.info('MAIN -> Hacker: Sending funding for gas...');
  const fundTx = await parentWalletMain.sendTransaction({
    to: hackerAccount.address,
    value: config.hackerFundingAmount,
    chain: getParentChain(),
    account: mainAccount,
  });
  await parentClient.waitForTransactionReceipt({ hash: fundTx });
  logger.txHash(fundTx, 'sendTransaction', 'success');
  logger.success(`MAIN -> Hacker: ${formatEther(config.hackerFundingAmount)} ETH sent`);

  // Hacker deposits to L2
  const parentWalletHacker = createWalletClient({
    account: hackerAccount,
    chain: getParentChain(),
    transport: http(envConfig.parentChainRpc),
  });

  logger.info('Hacker depositing to L2...');
  const depositTxHacker = await parentWalletHacker.writeContract({
    address: coreContracts.inbox as Address,
    abi: inboxAbi,
    functionName: 'depositEth',
    value: config.hackerDepositAmount,
    chain: getParentChain(),
    account: hackerAccount,
  });

  await parentClient.waitForTransactionReceipt({ hash: depositTxHacker });
  logger.txHash(depositTxHacker, 'depositEth', 'success');
  logger.success('Hacker deposit confirmed on parent chain');

  ctx?.stepCompleted('Generating and funding Hacker account');

  // ========================================================================
  // Step 4: Wait for funds on child chain
  // ========================================================================
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Waiting for funds on child chain');
  tracker.start();

  const expectedMainBalance = mainBalanceBefore + config.mainDepositAmount;
  logger.info(`Waiting for MAIN balance >= ${formatEther(expectedMainBalance)} ETH...`);

  const mainBalanceAfter = await waitForBalance(
    childClient,
    mainAccount.address,
    expectedMainBalance,
    60,
    2000,
    ctx?.signal,
  );
  logger.success(`MAIN L2 balance: ${formatEther(mainBalanceAfter)} ETH`);

  logger.info(`Waiting for Hacker balance >= ${formatEther(config.hackerDepositAmount)} ETH...`);
  const hackerBalanceAfter = await waitForBalance(
    childClient,
    hackerAccount.address,
    config.hackerDepositAmount,
    60,
    2000,
    ctx?.signal,
  );
  logger.success(`Hacker L2 balance: ${formatEther(hackerBalanceAfter)} ETH`);

  ctx?.stepCompleted('Waiting for funds on child chain');

  // ========================================================================
  // Step 5: Hacker calls ArbMinter.mintBalanceTo
  // ========================================================================
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Hacker minting via ArbMinter');
  tracker.start();

  const childWalletHacker = createWalletClient({
    account: hackerAccount,
    chain: childChain,
    transport: http(envConfig.chainRpc),
  });

  // Mint the same amount as MAIN deposited
  const mintAmount = config.mainDepositAmount;
  logger.info(`Minting ${formatEther(mintAmount)} ETH to Hacker...`);

  const mintTx = await childWalletHacker.writeContract({
    address: ARB_MINTER_ADDRESS,
    abi: arbMinterAbi,
    functionName: 'mintBalanceTo',
    args: [hackerAccount.address, mintAmount],
    chain: childChain as Chain,
    account: hackerAccount,
  });

  await childClient.waitForTransactionReceipt({ hash: mintTx });
  logger.txHash(mintTx, 'mintBalanceTo', 'success');
  logger.event(`Hacker minted ${formatEther(mintAmount)} ETH via ArbMinter`);

  const hackerBalanceAfterMint = await childClient.getBalance({ address: hackerAccount.address });
  logger.success(`Hacker new balance: ${formatEther(hackerBalanceAfterMint)} ETH`);

  ctx?.stepCompleted('Hacker minting via ArbMinter');

  // ========================================================================
  // Step 6: Hacker calls ArbSys.withdrawEth
  // ========================================================================
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Hacker withdrawing via ArbSys');
  tracker.start();

  // Withdraw the minted amount
  const withdrawAmount = mintAmount;
  logger.info(`Withdrawing ${formatEther(withdrawAmount)} ETH to Hacker on L1...`);

  const withdrawTx = await childWalletHacker.writeContract({
    address: ARB_SYS_ADDRESS,
    abi: arbSysAbi,
    functionName: 'withdrawEth',
    args: [hackerAccount.address],
    value: withdrawAmount,
    chain: childChain as Chain,
    account: hackerAccount,
  });

  const withdrawReceipt = await childClient.waitForTransactionReceipt({ hash: withdrawTx });
  logger.txHash(withdrawTx, 'withdrawEth', 'success');
  logger.success('Withdrawal TX confirmed on L2');

  const l2ToL1TxData = await parseL2ToL1TxData(withdrawReceipt, childClient);

  ctx?.stepCompleted('Hacker withdrawing via ArbSys');

  // ========================================================================
  // Step 7: Check confirmPeriodBlocks and start monitor
  // ========================================================================
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Starting rollup monitor');
  tracker.start();

  const confirmPeriodBlocks = (await parentClient.readContract({
    address: coreContracts.rollup as Address,
    abi: rollupCoreAbi,
    functionName: 'confirmPeriodBlocks',
  })) as bigint;

  logger.info(`Rollup confirmPeriodBlocks: ${confirmPeriodBlocks}`);

  await startRollupMonitor(parentClient, coreContracts, {
    childClient,
    watchMessage: l2ToL1TxData
      ? {
          position: l2ToL1TxData.position,
          label: 'withdrawal',
        }
      : undefined,
  });
  ctx?.onCleanup(async () => stopRollupMonitor());
  ctx?.stepCompleted('Starting rollup monitor');

  // ========================================================================
  // Step 8: Wait for withdrawal to be ready
  // ========================================================================
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Waiting for withdrawal readiness');
  tracker.start();

  const { withdrawalExecuted, withdrawalTxHash, withdrawalExecutionError } = await executeOrPollWithdrawal({
    confirmPeriodBlocks,
    envConfig,
    hackerPrivateKey,
    hackerAddress: hackerAccount.address,
    withdrawTx,
    parentClient,
    ctx,
  });
  ctx?.stepCompleted('Waiting for withdrawal readiness');

  // ========================================================================
  // Step 9: Check final bridge balance
  // ========================================================================
  ctx?.throwIfCancelled();
  ctx?.stepStarted('Final bridge balance check');
  tracker.start();

  stopRollupMonitor();

  const bridgeBalanceFinal = await parentClient.getBalance({
    address: coreContracts.bridge as Address,
  });

  logger.info(`Bridge initial: ${formatEther(bridgeBalanceInitial)} ETH`);
  logger.info(`Bridge final: ${formatEther(bridgeBalanceFinal)} ETH`);

  const balanceDiff = bridgeBalanceFinal - bridgeBalanceInitial;
  if (balanceDiff > BigInt(0)) {
    logger.success(`Bridge balance increased by ${formatEther(balanceDiff)} ETH (from deposits)`);
  } else if (balanceDiff < BigInt(0)) {
    logger.warn(`Bridge balance decreased by ${formatEther(-balanceDiff)} ETH (from withdrawals)`);
  } else {
    logger.info('Bridge balance unchanged');
  }

  // Summary
  ctx?.stepCompleted('Final bridge balance check');
  tracker.complete('Malicious Mint Demo completed');
  logger.section('Demo Complete');
  logger.raw('');
  logger.raw('Summary:');
  logger.raw(`  MAIN deposited: ${formatEther(config.mainDepositAmount)} ETH`);
  logger.raw(`  Hacker deposited: ${formatEther(config.hackerDepositAmount)} ETH`);
  logger.raw(`  Hacker minted: ${formatEther(mintAmount)} ETH (malicious)`);
  logger.raw(`  Hacker withdrew: ${formatEther(withdrawAmount)} ETH`);
  logger.raw(`  Hacker address: ${hackerAccount.address}`);
  logger.raw(`  Hacker private key: ${hackerPrivateKey}`);
  logger.raw(`  confirmPeriodBlocks: ${confirmPeriodBlocks}`);
  logger.raw('');

  if (confirmPeriodBlocks < BigInt(20)) {
    if (withdrawalExecuted && withdrawalTxHash) {
      logger.success('Withdrawal executed successfully on L1!');
      logger.success(`  TX Hash: ${withdrawalTxHash}`);
    } else if (withdrawalExecutionError) {
      logger.errorWithFix(
        `Withdrawal execution failed: ${withdrawalExecutionError}`,
        'Use the Outbox contract to execute the withdrawal manually after the challenge period.',
      );
    } else {
      logger.warn('Withdrawal was not executed.');
    }
  } else {
    logger.warn('Note: The withdrawal execution on L1 requires the challenge period to pass.');
    logger.warn('Use the Outbox contract to execute the withdrawal when ready.');
  }

  return {
    success: true,
    mainAddress: mainAccount.address,
    hackerAddress: hackerAccount.address,
    hackerPrivateKey: hackerPrivateKey,
    mintAmount,
    withdrawAmount,
    confirmPeriodBlocks,
    bridgeBalanceInitial,
    bridgeBalanceFinal,
  };
}
