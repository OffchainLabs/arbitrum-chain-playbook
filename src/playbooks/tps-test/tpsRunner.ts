import * as fs from 'fs';
import * as path from 'path';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  formatUnits,
  http,
  maxUint256,
  parseAbi,
  parseEther,
  parseUnits,
  type Abi,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

// =============================================================================
// Debug Logger
// =============================================================================

const DEBUG_LOG_FILE = path.join(process.cwd(), 'tps-test-debug.log');

// Buffer for async log writes
let logBuffer: string[] = [];
let isFlushingLog = false;

function debugLog(message: string, data?: unknown): void {
  const timestamp = new Date().toISOString();
  let logEntry = `[${timestamp}] ${message}`;
  if (data !== undefined) {
    logEntry += `\n${JSON.stringify(data, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}`;
  }
  logEntry += '\n';
  logBuffer.push(logEntry);

  // Flush buffer asynchronously if not already flushing
  if (!isFlushingLog && logBuffer.length >= 10) {
    flushLogBuffer();
  }
}

async function flushLogBuffer(): Promise<void> {
  if (isFlushingLog || logBuffer.length === 0) return;
  isFlushingLog = true;
  const entries = logBuffer.splice(0, logBuffer.length);
  try {
    fs.appendFileSync(DEBUG_LOG_FILE, entries.join(''));
  } catch {
    // Ignore write errors
  }
  isFlushingLog = false;
}

function clearDebugLog(): void {
  logBuffer = [];
  fs.writeFileSync(DEBUG_LOG_FILE, `=== TPS Test Debug Log ===\nStarted at: ${new Date().toISOString()}\n\n`);
}
import {
  TpsTestConfig,
  ContractAddresses,
  SignedTxWithMeta,
  TxHashWithMeta,
  BroadcastResult,
  ConfirmResult,
  TpsAnalysis,
  BlockStats,
} from './types.js';
import {
  generatePayload,
  signTransactions,
  calculateFundingNeeds,
  getRequiredContracts,
  ERC20_ABI,
  ROUTER_ABI,
} from './payloadGenerator.js';
import { deployToken } from './deployToken.js';
import { deployUniswap } from './deployUniswap.js';
import * as ui from './ui.js';

/**
 * TPS Test Runner (viem)
 *
 * Main orchestrator for TPS testing with support for:
 * - ETH transfers
 * - ERC20 token transfers
 * - Uniswap swaps
 */

// =============================================================================
// Default Configuration
// =============================================================================

export const DEFAULT_TPS_CONFIG: TpsTestConfig = {
  rpcUrl: process.env.RPC_URL || 'http://127.0.0.1:8547',
  funderPrivateKey: '0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659',
  txCount: 1000,
  senderCount: 50,
  txValue: '0.000000000000000001', // 1 wei
  fundingAmount: '0.01',
  tokenTxValue: '100',
  swapValue: '0.000000000000000001', // 1 wei
  gasLimit: 100000, // Higher for L2 chains (intrinsic gas can be > 21000)
  concurrentRequests: 200,
  gasMultiplier: 4,
  txMix: { ethTransfer: 100, tokenTransfer: 0, swap: 0 },
  verifyAll: false,
  contracts: {
    token: null,
    weth: null,
    router: null,
    factory: null,
    pair: null,
  },
};

// =============================================================================
// Utility Functions
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =============================================================================
// Contract Deployment (Token + Uniswap if needed)
// =============================================================================

async function setupContracts(
  config: TpsTestConfig,
  publicClient: PublicClient,
  walletClient: WalletClient,
  funderAccount: PrivateKeyAccount,
): Promise<ContractAddresses> {
  const { needsToken, needsUniswap } = getRequiredContracts(config.txMix);

  if (!needsToken && !needsUniswap) {
    console.log('\n📦 No contracts needed for ETH-only transfers');
    return config.contracts;
  }

  console.log('\n' + '='.repeat(60));
  console.log('📦 CONTRACT SETUP PHASE');
  console.log('='.repeat(60));
  console.log(`   Needs Token: ${needsToken}`);
  console.log(`   Needs Uniswap: ${needsUniswap}`);

  const contracts = { ...config.contracts };

  // Check if contracts are already provided
  if (contracts.token && (!needsUniswap || (contracts.weth && contracts.router))) {
    console.log('\n✅ Using pre-deployed contracts:');
    console.log(`   Token: ${contracts.token}`);
    if (needsUniswap) {
      console.log(`   WETH: ${contracts.weth}`);
      console.log(`   Router: ${contracts.router}`);
    }
    return contracts;
  }

  // Deploy Token if needed
  if (needsToken && !contracts.token) {
    console.log('\n🪙 Deploying Test Token...');

    const tokenResult = await deployToken({
      rpcUrl: config.rpcUrl,
      deployerPrivateKey: config.funderPrivateKey,
      tokenName: 'TPS Test Token',
      tokenSymbol: 'TPSTEST',
      tokenDecimals: 18,
      initialSupply: '10000000000', // 10 billion tokens
    });

    contracts.token = tokenResult.contractAddress;
    console.log(`✅ Token deployed: ${contracts.token}`);
  }

  // Deploy Uniswap if needed
  if (needsUniswap && !contracts.router) {
    console.log('\n🦄 Deploying Uniswap V2...');

    const uniswapResult = await deployUniswap({
      rpcUrl: config.rpcUrl,
      deployerPrivateKey: config.funderPrivateKey,
    });

    contracts.weth = uniswapResult.weth.address;
    contracts.factory = uniswapResult.factory.address;
    contracts.router = uniswapResult.router.address;

    console.log(`✅ WETH: ${contracts.weth}`);
    console.log(`✅ Factory: ${contracts.factory}`);
    console.log(`✅ Router: ${contracts.router}`);

    // Create liquidity pool
    console.log('\n💧 Creating Token/ETH liquidity pool...');

    // Approve router for initial liquidity
    const liquidityTokenAmount = parseUnits('1000000000', 18); // 1B tokens
    const liquidityEthAmount = parseEther('100'); // 100 ETH

    let nonce = await publicClient.getTransactionCount({ address: funderAccount.address, blockTag: 'pending' });

    const approveHash = await walletClient.writeContract({
      account: funderAccount,
      chain: null,
      address: contracts.token as `0x${string}`,
      abi: ERC20_ABI as Abi,
      functionName: 'approve',
      args: [contracts.router as `0x${string}`, liquidityTokenAmount],
      nonce: nonce++,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
    console.log(`   Approved router to spend tokens`);

    // Add liquidity
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const addLiqHash = await walletClient.writeContract({
      account: funderAccount,
      chain: null,
      address: contracts.router as `0x${string}`,
      abi: ROUTER_ABI as Abi,
      functionName: 'addLiquidityETH',
      args: [
        contracts.token as `0x${string}`,
        liquidityTokenAmount,
        liquidityTokenAmount,
        liquidityEthAmount,
        funderAccount.address,
        deadline,
      ],
      value: liquidityEthAmount,
      nonce: nonce++,
      gas: 5_000_000n,
    });
    await publicClient.waitForTransactionReceipt({ hash: addLiqHash });

    // Get pair address
    const factoryAbi = parseAbi(['function getPair(address, address) view returns (address)']);
    contracts.pair = await publicClient.readContract({
      address: contracts.factory as `0x${string}`,
      abi: factoryAbi,
      functionName: 'getPair',
      args: [contracts.token as `0x${string}`, contracts.weth as `0x${string}`],
    });

    console.log(`✅ Liquidity added! Pair: ${contracts.pair}`);
  }

  console.log('\n' + '='.repeat(60));

  return contracts;
}

// =============================================================================
// Account Management
// =============================================================================

async function createAndFundSenders(
  publicClient: PublicClient,
  funderAccount: PrivateKeyAccount,
  chainId: number,
  count: number,
  config: TpsTestConfig,
  contracts: ContractAddresses,
): Promise<PrivateKeyAccount[]> {
  console.log(`\n📦 Creating ${count} sender accounts...`);

  const senders: PrivateKeyAccount[] = [];

  // Create wallets
  for (let i = 0; i < count; i++) {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    senders.push(account);
  }

  console.log(`✅ Created ${count} wallets`);

  // Calculate funding needs based on tx mix (fetches real-time gas price and estimates gas from chain)
  const fundingNeeds = await calculateFundingNeeds(config, count, publicClient, funderAccount.address);
  const ethFunding = fundingNeeds.ethPerSender;
  const tokenFunding = fundingNeeds.tokensPerSender;

  console.log(`\n💸 Funding ${count} sender accounts...`);
  console.log(`   ETH per sender: ${formatEther(ethFunding)} ETH`);

  if (config.txMix.tokenTransfer > 0) {
    console.log(`   Tokens per sender: ${formatUnits(tokenFunding, 18)} tokens`);
  }

  // Get funder's nonce and fee data with buffer
  let nonce = await publicClient.getTransactionCount({ address: funderAccount.address, blockTag: 'pending' });
  const feeData = await publicClient.estimateFeesPerGas();
  const gasPrice = await publicClient.getGasPrice();

  // Use gas multiplier for funding too
  const multiplier = BigInt(Math.floor((config.gasMultiplier || 2) * 100));
  const maxFeePerGas = ((feeData.maxFeePerGas ?? gasPrice) * multiplier) / 100n;

  // Debug log funding configuration
  debugLog('=== ETH Funding Configuration ===', {
    funderAddress: funderAccount.address,
    senderCount: count,
    ethPerSender: ethFunding.toString(),
    ethPerSenderFormatted: formatEther(ethFunding),
    startingNonce: nonce,
    chainId,
    gasPrice: gasPrice.toString(),
    maxFeePerGas: maxFeePerGas.toString(),
    maxPriorityFeePerGas: (feeData.maxPriorityFeePerGas ?? 0n).toString(),
    gasMultiplier: config.gasMultiplier,
    rpcUrl: config.rpcUrl,
  });

  // Pre-sign all ETH funding transactions
  console.log(`   Pre-signing ${count} ETH funding transactions...`);
  const fundingTxs: { signedTx: string; senderIdx: number }[] = [];
  const txHashes: { hash: string; senderIdx: number }[] = [];

  // Estimate gas for a sample funding transaction dynamically
  let fundingGasLimit = 100000n; // fallback
  try {
    const estimatedFundingGas = await publicClient.estimateGas({
      account: funderAccount.address,
      to: senders[0].address,
      value: ethFunding,
    });
    // Apply 1.5x buffer
    fundingGasLimit = (estimatedFundingGas * 150n) / 100n;
    debugLog('=== Funding Gas Estimation ===', {
      estimatedGas: estimatedFundingGas.toString(),
      gasLimitWithBuffer: fundingGasLimit.toString(),
    });
    console.log(`   Estimated funding gas: ${estimatedFundingGas} (using ${fundingGasLimit} with 1.5x buffer)`);
  } catch (err) {
    debugLog('=== Funding Gas Estimation Failed ===', {
      error: err instanceof Error ? err.message : String(err),
      usingFallback: fundingGasLimit.toString(),
    });
    console.log(`   Gas estimation failed, using fallback: ${fundingGasLimit}`);
  }

  for (let i = 0; i < senders.length; i++) {
    const tx = {
      to: senders[i].address,
      value: ethFunding,
      nonce: nonce++,
      gas: fundingGasLimit,
      chainId: chainId,
      type: 'eip1559' as const,
      maxFeePerGas: maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 0n,
    };

    // Log first transaction details for debugging
    if (i === 0) {
      debugLog('=== First Funding Transaction Details ===', {
        to: tx.to,
        value: tx.value.toString(),
        nonce: tx.nonce,
        gas: tx.gas.toString(),
        chainId: tx.chainId,
        type: tx.type,
        maxFeePerGas: tx.maxFeePerGas.toString(),
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas.toString(),
      });
    }

    const signedTx = await funderAccount.signTransaction(tx);
    fundingTxs.push({ signedTx, senderIdx: i });
  }

  // Broadcast ETH funding transactions
  console.log(`   Broadcasting ${count} ETH funding transactions...`);
  let broadcastSuccess = 0;
  let broadcastFailed = 0;

  const batchSize = Math.min(200, count);
  for (let i = 0; i < fundingTxs.length; i += batchSize) {
    const batch = fundingTxs.slice(i, i + batchSize);

    const batchPromises = batch.map(async ({ signedTx, senderIdx }) => {
      try {
        const response = await fetch(config.rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'eth_sendRawTransaction',
            params: [signedTx],
            id: senderIdx,
          }),
        });
        const result = (await response.json()) as { result?: string; error?: { code?: number; message?: string } };
        if (result.result) {
          txHashes.push({ hash: result.result, senderIdx });
          return true;
        }
        // Log all errors for debugging
        if (result.error) {
          debugLog(`ETH Funding TX Error [${senderIdx}]`, {
            senderIdx,
            error: result.error,
          });
        }
        return false;
      } catch (err) {
        debugLog(`ETH Funding TX Exception [${senderIdx}]`, {
          senderIdx,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    });

    const results = await Promise.all(batchPromises);
    broadcastSuccess += results.filter((r) => r).length;
    broadcastFailed += results.filter((r) => !r).length;

    process.stdout.write(`\r   ETH Broadcast: ${i + batch.length}/${count} (✓${broadcastSuccess} ✗${broadcastFailed})`);
  }
  console.log();

  if (broadcastSuccess === 0) {
    console.log(`❌ All ETH funding transactions failed to broadcast`);
    return [];
  }

  // Wait for ETH funding to confirm
  console.log(`   Waiting for ETH funding to confirm...`);
  const startWait = Date.now();
  const timeout = Math.max(30000, count * 10);

  let funded = 0;
  let lastFunded = 0;
  let stableCount = 0;

  while (Date.now() - startWait < timeout) {
    let currentFunded = 0;

    for (let i = 0; i < senders.length; i += 100) {
      const batch = senders.slice(i, i + 100);
      const balancePromises = batch.map((s) => publicClient.getBalance({ address: s.address }).catch(() => 0n));
      const balances = await Promise.all(balancePromises);
      currentFunded += balances.filter((b) => b > 0n).length;
    }

    funded = currentFunded;
    const elapsed = ((Date.now() - startWait) / 1000).toFixed(1);
    process.stdout.write(`\r   Funded: ${funded}/${count} (${elapsed}s elapsed)`);

    if (funded >= broadcastSuccess) break;

    if (funded === lastFunded) {
      stableCount++;
      if (stableCount >= 5) {
        console.log(`\n   ⚠️  Funding stabilized at ${funded}/${count}`);
        break;
      }
    } else {
      stableCount = 0;
    }
    lastFunded = funded;

    await sleep(500);
  }
  console.log();

  // Filter funded senders
  const fundedSenders: PrivateKeyAccount[] = [];
  for (const sender of senders) {
    try {
      const balance = await publicClient.getBalance({ address: sender.address });
      if (balance > 0n) {
        fundedSenders.push(sender);
      }
    } catch {
      // Skip failed balance checks
    }
  }

  console.log(`✅ ETH funded ${fundedSenders.length}/${count} sender accounts`);

  // Distribute tokens if needed
  if (config.txMix.tokenTransfer > 0 && contracts.token && fundedSenders.length > 0) {
    console.log(`\n🪙 Distributing tokens to senders...`);

    nonce = await publicClient.getTransactionCount({ address: funderAccount.address, blockTag: 'pending' });

    // Pre-sign token transfers
    const tokenTxs: { signedTx: string; senderIdx: number }[] = [];
    for (let i = 0; i < fundedSenders.length; i++) {
      const data = encodeFunctionData({
        abi: ERC20_ABI as Abi,
        functionName: 'transfer',
        args: [fundedSenders[i].address, tokenFunding],
      });
      const tx = {
        to: contracts.token as `0x${string}`,
        value: 0n,
        data: data,
        nonce: nonce++,
        gas: 100000n,
        chainId: chainId,
        type: 'eip1559' as const,
        maxFeePerGas: maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 0n,
      };

      const signedTx = await funderAccount.signTransaction(tx);
      tokenTxs.push({ signedTx, senderIdx: i });
    }

    // Broadcast token transfers
    let tokenSuccess = 0;
    for (let i = 0; i < tokenTxs.length; i += batchSize) {
      const batch = tokenTxs.slice(i, i + batchSize);

      const batchPromises = batch.map(async ({ signedTx }) => {
        try {
          const response = await fetch(config.rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              method: 'eth_sendRawTransaction',
              params: [signedTx],
              id: 1,
            }),
          });
          const result = (await response.json()) as { result?: string };
          return result.result ? true : false;
        } catch {
          return false;
        }
      });

      const results = await Promise.all(batchPromises);
      tokenSuccess += results.filter((r) => r).length;

      process.stdout.write(`\r   Token distribution: ${i + batch.length}/${fundedSenders.length}`);
    }
    console.log();

    // Wait for token transfers
    await sleep(2000);
    console.log(`✅ Token distribution sent (${tokenSuccess} txs)`);
  }

  // Approve router for swaps if needed
  if (config.txMix.swap > 0 && contracts.router && fundedSenders.length > 0) {
    console.log(`\n🔓 Approving router for all senders (for token->ETH swaps)...`);

    const approvalAmount = maxUint256;

    // Each sender approves the router
    let approvalSuccess = 0;
    const approvalBatchSize = 50;

    for (let i = 0; i < fundedSenders.length; i += approvalBatchSize) {
      const batch = fundedSenders.slice(i, i + approvalBatchSize);

      const approvalPromises = batch.map(async (sender) => {
        try {
          const senderNonce = await publicClient.getTransactionCount({ address: sender.address, blockTag: 'pending' });
          const data = encodeFunctionData({
            abi: ERC20_ABI as Abi,
            functionName: 'approve',
            args: [contracts.router!, approvalAmount],
          });

          const tx = {
            to: contracts.token as `0x${string}`,
            value: 0n,
            data: data,
            nonce: senderNonce,
            gas: 100000n,
            chainId: chainId,
            type: 'eip1559' as const,
            maxFeePerGas: maxFeePerGas,
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 0n,
          };

          const signedTx = await sender.signTransaction(tx);

          const response = await fetch(config.rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              method: 'eth_sendRawTransaction',
              params: [signedTx],
              id: 1,
            }),
          });
          const result = (await response.json()) as { result?: string };
          return result.result ? true : false;
        } catch {
          return false;
        }
      });

      const results = await Promise.all(approvalPromises);
      approvalSuccess += results.filter((r) => r).length;

      process.stdout.write(`\r   Approvals: ${i + batch.length}/${fundedSenders.length}`);
    }
    console.log();

    // Wait for approvals to confirm
    await sleep(2000);
    console.log(`✅ Router approvals sent (${approvalSuccess} txs)`);
  }

  if (fundedSenders.length < count) {
    console.log(
      `   ⚠️  ${count - fundedSenders.length} accounts not funded (will use ${fundedSenders.length} senders)`,
    );
  }

  return fundedSenders;
}

// =============================================================================
// Parallel Broadcaster
// =============================================================================

async function fireAndForgetBroadcast(signedTxs: SignedTxWithMeta[], config: TpsTestConfig): Promise<BroadcastResult> {
  console.log(`\n🚀 Broadcasting ${signedTxs.length} transactions...`);
  console.log(`   Concurrency: ${config.concurrentRequests} parallel requests`);
  console.log(
    `   Mix: ${config.txMix.ethTransfer}% ETH | ${config.txMix.tokenTransfer}% Token | ${config.txMix.swap}% Swap`,
  );

  const startTime = Date.now();
  let successCount = 0;
  let errorCount = 0;
  let firstError: string | null = null;
  const txHashes: TxHashWithMeta[] = [];

  // Track error types
  const errorTypes = new Map<string, number>();

  // Simple semaphore using a counter
  let nextIndex = 0;

  // Categorize error messages
  const categorizeError = (errorMsg: string): string => {
    if (!errorMsg) return 'unknown';
    const msg = errorMsg.toLowerCase();
    if (msg.includes('max fee per gas less than block base fee')) return 'gas_price_too_low';
    if (msg.includes('nonce too low')) return 'nonce_too_low';
    if (msg.includes('nonce too high')) return 'nonce_too_high';
    if (msg.includes('already known')) return 'already_known';
    if (msg.includes('replacement transaction underpriced')) return 'replacement_underpriced';
    if (msg.includes('insufficient funds')) return 'insufficient_funds';
    if (msg.includes('intrinsic gas too low')) return 'gas_too_low';
    if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) return 'timeout';
    if (msg.includes('connection') || msg.includes('ECONNREFUSED')) return 'connection_error';
    if (msg.includes('execution reverted')) return 'execution_reverted';
    return 'other';
  };

  // Create a pool of workers
  const worker = async (): Promise<void> => {
    while (nextIndex < signedTxs.length) {
      const idx = nextIndex++;
      const { signedTx, index, expectedFrom, txType } = signedTxs[idx];

      try {
        const response = await fetch(config.rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'eth_sendRawTransaction',
            params: [signedTx],
            id: index,
          }),
        });

        const result = (await response.json()) as { result?: string; error?: { message?: string } };

        if (result.result) {
          successCount++;
          txHashes.push({ hash: result.result, index, expectedFrom, txType });
        } else {
          errorCount++;
          const errorMsg = result.error?.message || 'Unknown error';
          const errorType = categorizeError(errorMsg);
          errorTypes.set(errorType, (errorTypes.get(errorType) || 0) + 1);

          if (!firstError) firstError = errorMsg;
        }
      } catch (err) {
        errorCount++;
        const errorType = categorizeError(err instanceof Error ? err.message : 'unknown');
        errorTypes.set(errorType, (errorTypes.get(errorType) || 0) + 1);

        if (!firstError) firstError = err instanceof Error ? err.message : 'unknown';
      }

      // Progress update
      const total = successCount + errorCount;
      if (total % 100 === 0 || total === signedTxs.length) {
        const elapsed = Date.now() - startTime;
        const rate = (total / elapsed) * 1000;
        process.stdout.write(
          `\r   Progress: ${total}/${signedTxs.length} (✓${successCount} ✗${errorCount}) ${rate.toFixed(0)} tx/s`,
        );
      }
    }
  };

  // Start workers
  const workers: Promise<void>[] = [];
  for (let i = 0; i < config.concurrentRequests; i++) {
    workers.push(worker());
  }

  // Wait for all workers to complete
  await Promise.all(workers);

  const endTime = Date.now();
  const totalTime = endTime - startTime;

  console.log(`\n✅ Broadcast complete in ${ui.formatDuration(totalTime)}`);
  console.log(`   Success: ${successCount}, Failed: ${errorCount}`);

  if (firstError) {
    console.log(`   First error: ${String(firstError).substring(0, 100)}...`);
  }

  // Convert errorTypes Map to object for return
  const errorTypesObj: Record<string, number> = {};
  for (const [type, count] of errorTypes) {
    errorTypesObj[type] = count;
  }

  return {
    txHashes,
    successCount,
    errorCount,
    firstError,
    broadcastDuration: totalTime,
    errorTypes: errorTypesObj,
  };
}

// =============================================================================
// Confirmation Tracking
// =============================================================================

async function waitForConfirmations(
  publicClient: PublicClient,
  txHashes: TxHashWithMeta[],
  timeoutMs = 180000, // Increased for large tx counts
): Promise<ConfirmResult> {
  console.log(`\n⏳ Waiting for ${txHashes.length} transactions to confirm...`);

  const startTime = Date.now();
  const receipts: TransactionReceipt[] = [];
  const pending = new Set(txHashes.map((t) => t.hash));

  // Scale batch size with transaction count (up to 2000 concurrent requests)
  const batchSize = Math.min(2000, Math.max(200, Math.floor(txHashes.length / 25)));

  while (pending.size > 0 && Date.now() - startTime < timeoutMs) {
    const checkBatch = Array.from(pending).slice(0, batchSize);

    const receiptPromises = checkBatch.map(async (hash) => {
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash: hash as `0x${string}` });
        if (receipt) {
          pending.delete(hash);
          return receipt;
        }
      } catch {
        // Ignore errors, will retry
      }
      return null;
    });

    const batchReceipts = await Promise.all(receiptPromises);

    for (const receipt of batchReceipts) {
      if (receipt) receipts.push(receipt);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    process.stdout.write(
      `\r   Verifying: ${receipts.length}/${txHashes.length} confirmed (${pending.size} pending, ${elapsed}s)`,
    );

    if (pending.size > 0) {
      // Shorter sleep for faster polling
      await sleep(100);
    }
  }

  const confirmDuration = Date.now() - startTime;
  console.log(`\n✅ Confirmed ${receipts.length}/${txHashes.length} in ${ui.formatDuration(confirmDuration)}`);

  return { receipts, confirmDuration };
}

// =============================================================================
// TPS Analysis
// =============================================================================

async function analyzeBlockTPS(
  publicClient: PublicClient,
  receipts: TransactionReceipt[],
  broadcastStartTime: number,
  broadcastEndTime: number,
  txHashesWithMeta: TxHashWithMeta[],
): Promise<TpsAnalysis | null> {
  if (receipts.length === 0) {
    console.log('⚠️  No receipts to analyze');
    return null;
  }

  console.log(`\n📊 Analyzing on-chain TPS...`);

  // Find block range from receipts
  const blockNumbers = [...new Set(receipts.map((r) => Number(r.blockNumber)))].sort((a, b) => a - b);
  const firstBlock = Math.min(...blockNumbers);
  const lastBlock = Math.max(...blockNumbers);

  console.log(`   Block range: ${firstBlock} - ${lastBlock} (${blockNumbers.length} blocks)`);

  // Fetch blocks in batches to avoid overwhelming the RPC
  const blockBatchSize = 50;
  const blocks = [];
  for (let i = firstBlock; i <= lastBlock; i += blockBatchSize) {
    const batchEnd = Math.min(i + blockBatchSize, lastBlock + 1);
    const batchPromises = [];
    for (let j = i; j < batchEnd; j++) {
      batchPromises.push(publicClient.getBlock({ blockNumber: BigInt(j), includeTransactions: false }));
    }
    const batchBlocks = await Promise.all(batchPromises);
    blocks.push(...batchBlocks);
    process.stdout.write(`\r   Fetching blocks: ${blocks.length}/${lastBlock - firstBlock + 1}`);
  }
  console.log();

  // Build transaction hash to metadata map (O(1) lookups)
  const txHashToMeta = new Map<string, { index: number; expectedFrom: string; txType: string }>();
  for (const { hash, index, expectedFrom, txType } of txHashesWithMeta) {
    txHashToMeta.set(hash.toLowerCase(), { index, expectedFrom, txType });
  }

  // Build receipt map for O(1) lookups instead of O(n) find()
  const receiptMap = new Map<string, TransactionReceipt>();
  for (const receipt of receipts) {
    receiptMap.set(receipt.transactionHash.toLowerCase(), receipt);
  }

  // Analyze blocks
  const blockStats: BlockStats[] = [];
  let totalBlockTxCount = 0;
  let ourTxCount = 0;
  let verifiedTxCount = 0;
  let verifiedSuccessfulCount = 0;
  let revertedTxCount = 0;

  // Track tx types in verified
  const verifiedByType: Record<string, number> = { eth_transfer: 0, token_transfer: 0, swap: 0 };

  for (const block of blocks) {
    if (!block) continue;

    const txHashes = block.transactions || [];
    totalBlockTxCount += txHashes.length;

    let blockOurTxCount = 0;

    for (const hash of txHashes) {
      const hashLower = hash.toLowerCase();
      if (txHashToMeta.has(hashLower)) {
        blockOurTxCount++;
        ourTxCount++;

        const meta = txHashToMeta.get(hashLower)!;
        const receipt = receiptMap.get(hashLower); // O(1) instead of O(n)

        if (receipt) {
          verifiedTxCount++;
          if (receipt.status === 'success') {
            verifiedSuccessfulCount++;
            if (meta.txType) {
              verifiedByType[meta.txType] = (verifiedByType[meta.txType] || 0) + 1;
            }
          } else {
            revertedTxCount++;
          }
        }
      }
    }

    blockStats.push({
      number: Number(block.number),
      timestamp: Number(block.timestamp),
      totalTxCount: txHashes.length,
      ourTxCount: blockOurTxCount,
      gasUsed: block.gasUsed,
    });
  }

  // Calculate TPS metrics
  const firstBlockData = blockStats[0];
  const lastBlockData = blockStats[blockStats.length - 1];
  const blockTimeSpanSeconds = lastBlockData.timestamp - firstBlockData.timestamp || 1;
  const actualTimeSpanSeconds = (broadcastEndTime - broadcastStartTime) / 1000;

  // Find peak block
  const peakBlock = blockStats.reduce((max, block) => (block.ourTxCount > max.ourTxCount ? block : max), blockStats[0]);

  // TPS calculations
  const blockBasedTps = verifiedTxCount / blockTimeSpanSeconds;
  const broadcastTps = verifiedTxCount / actualTimeSpanSeconds;
  const confirmedBlockTps = verifiedSuccessfulCount / blockTimeSpanSeconds;
  const confirmedBroadcastTps = verifiedSuccessfulCount / actualTimeSpanSeconds;

  return {
    blockCount: blockStats.length,
    firstBlock,
    lastBlock,
    blockTimeSpanSeconds,
    actualTimeSpanSeconds,
    avgBlockTime: blockTimeSpanSeconds / Math.max(1, blockStats.length - 1),
    totalBlockTxCount,
    ourTxCount,
    verifiedTxCount,
    verifiedSuccessfulCount,
    revertedTxCount,
    receiptsCount: receipts.length,
    sampleVerified: Math.min(10, verifiedTxCount),
    sampleSize: Math.min(10, verifiedTxCount),
    blockBasedTps,
    broadcastTps,
    confirmedBlockTps,
    confirmedBroadcastTps,
    peakBlock,
    blockStats,
    verifiedByType,
  };
}

// =============================================================================
// Report Generation
// =============================================================================

function generateReport(
  config: TpsTestConfig,
  sendResult: BroadcastResult,
  confirmResult: ConfirmResult,
  tpsAnalysis: TpsAnalysis | null,
): void {
  ui.printSection('Test Report', '📊');

  // Configuration
  ui.printSubSection('Configuration');
  ui.printStats({
    'Transaction count': ui.formatNumber(config.txCount),
    'Sender accounts': config.senderCount,
    'Concurrent requests': config.concurrentRequests,
    'Gas multiplier': `${config.gasMultiplier}x`,
    'Transaction mix': `${config.txMix.ethTransfer}% ETH │ ${config.txMix.tokenTransfer}% Token │ ${config.txMix.swap}% Swap`,
  });

  // Broadcast metrics
  ui.printSubSection('Broadcast Metrics');
  const broadcastRate = (sendResult.successCount / (sendResult.broadcastDuration / 1000)).toFixed(2);
  ui.printStats({
    'Signing time': sendResult.signDuration ? ui.formatDuration(sendResult.signDuration) : 'N/A',
    'Broadcast success': ui.style.success(sendResult.successCount),
    'Broadcast failed': sendResult.errorCount > 0 ? ui.style.error(sendResult.errorCount) : '0',
    'Broadcast time': ui.formatDuration(sendResult.broadcastDuration),
    'Broadcast rate': `${broadcastRate} tx/s`,
  });

  if (Object.keys(sendResult.errorTypes).length > 0) {
    console.log(`\n   ${ui.colors.dim}Error breakdown:${ui.colors.reset}`);
    const errorLabels: Record<string, string> = {
      gas_price_too_low: 'Gas price too low',
      nonce_too_low: 'Nonce too low',
      nonce_too_high: 'Nonce too high',
      already_known: 'Already known',
      replacement_underpriced: 'Replacement underpriced',
      insufficient_funds: 'Insufficient funds',
      gas_too_low: 'Gas limit too low',
      timeout: 'Timeout',
      connection_error: 'Connection error',
      execution_reverted: 'Execution reverted',
      other: 'Other',
      unknown: 'Unknown',
    };
    for (const [type, count] of Object.entries(sendResult.errorTypes)) {
      console.log(`     ${ui.colors.dim}•${ui.colors.reset} ${errorLabels[type] || type}: ${ui.style.warning(count)}`);
    }
  }

  // Confirmation metrics
  ui.printSubSection('Confirmation Metrics');
  ui.printStats({
    'Transactions confirmed': ui.style.success(confirmResult.receipts.length),
    'Confirmation time': ui.formatDuration(confirmResult.confirmDuration),
  });

  if (tpsAnalysis) {
    // On-chain verification
    ui.printSubSection('On-Chain Verification');
    ui.printStats({
      Blocks: `${tpsAnalysis.blockCount} (${tpsAnalysis.firstBlock} → ${tpsAnalysis.lastBlock})`,
      'Block timestamp span': `${tpsAnalysis.blockTimeSpanSeconds}s`,
      'Actual broadcast time': `${tpsAnalysis.actualTimeSpanSeconds.toFixed(2)}s`,
      'Avg block time': `${tpsAnalysis.avgBlockTime.toFixed(3)}s`,
      'Verified on-chain': ui.style.value(tpsAnalysis.verifiedTxCount),
      'Confirmed (status=1)': ui.style.success(tpsAnalysis.verifiedSuccessfulCount),
      'Reverted (status=0)': tpsAnalysis.revertedTxCount > 0 ? ui.style.error(tpsAnalysis.revertedTxCount) : '0',
    });

    // Breakdown by type if mixed
    if (config.txMix.tokenTransfer > 0 || config.txMix.swap > 0) {
      console.log(`\n   ${ui.colors.dim}By transaction type:${ui.colors.reset}`);
      console.log(
        `     ${ui.colors.dim}•${ui.colors.reset} ETH transfers:   ${ui.style.value(tpsAnalysis.verifiedByType.eth_transfer || 0)}`,
      );
      console.log(
        `     ${ui.colors.dim}•${ui.colors.reset} Token transfers: ${ui.style.value(tpsAnalysis.verifiedByType.token_transfer || 0)}`,
      );
      console.log(
        `     ${ui.colors.dim}•${ui.colors.reset} Swaps:           ${ui.style.value(tpsAnalysis.verifiedByType.swap || 0)}`,
      );
    }

    // TPS Results Box
    ui.printTPSResults(
      { blockTps: tpsAnalysis.blockBasedTps, broadcastTps: tpsAnalysis.broadcastTps },
      { blockTps: tpsAnalysis.confirmedBlockTps, broadcastTps: tpsAnalysis.confirmedBroadcastTps },
    );

    // Success rate
    const successRate = ((tpsAnalysis.verifiedSuccessfulCount / tpsAnalysis.verifiedTxCount) * 100).toFixed(1);
    const rateColor =
      Number(successRate) >= 99
        ? ui.colors.brightGreen
        : Number(successRate) >= 90
          ? ui.colors.brightYellow
          : ui.colors.brightRed;
    console.log(
      `\n   📈 Success Rate: ${rateColor}${successRate}%${ui.colors.reset} (${tpsAnalysis.verifiedSuccessfulCount}/${tpsAnalysis.verifiedTxCount})`,
    );

    // Peak block
    ui.printSubSection('Peak Block');
    ui.printStats({
      'Block number': tpsAnalysis.peakBlock.number,
      'Our transactions': ui.style.value(tpsAnalysis.peakBlock.ourTxCount),
      'Total transactions': tpsAnalysis.peakBlock.totalTxCount,
    });

    // Block-by-block breakdown for small tests
    if (tpsAnalysis.blockStats.length <= 15) {
      console.log(`\n   ${ui.colors.dim}Block-by-block:${ui.colors.reset}`);
      ui.printTable(
        ['Block', 'Time', 'Our TXs', 'Total', 'Gas Used'],
        tpsAnalysis.blockStats.map((b) => [
          b.number,
          b.timestamp,
          b.ourTxCount,
          b.totalTxCount,
          b.gasUsed.toString().slice(0, 10),
        ]),
        [10, 10, 8, 8, 12],
      );
    }
  }

  console.log(`\n${ui.colors.dim}${'─'.repeat(64)}${ui.colors.reset}`);
  ui.success('Test completed!');
}

// =============================================================================
// Main TPS Test Function
// =============================================================================

export async function runTpsTest(config: Partial<TpsTestConfig> = {}): Promise<void> {
  const fullConfig: TpsTestConfig = { ...DEFAULT_TPS_CONFIG, ...config };

  // Clear and initialize debug log
  clearDebugLog();
  debugLog('=== TPS Test Started ===', {
    config: {
      rpcUrl: fullConfig.rpcUrl,
      txCount: fullConfig.txCount,
      senderCount: fullConfig.senderCount,
      txValue: fullConfig.txValue,
      swapValue: fullConfig.swapValue,
      gasLimit: fullConfig.gasLimit,
      gasMultiplier: fullConfig.gasMultiplier,
      txMix: fullConfig.txMix,
    },
  });

  // Print banner
  ui.printBanner();

  console.log(
    `\n${ui.colors.dim}Transaction Mix:${ui.colors.reset} ${ui.style.value(`${fullConfig.txMix.ethTransfer}%`)} ETH │ ${ui.style.value(`${fullConfig.txMix.tokenTransfer}%`)} Token │ ${ui.style.value(`${fullConfig.txMix.swap}%`)} Swap`,
  );

  // Connect to provider
  ui.printSection('Connection', '🔗');
  const spinner = ui.createSpinner(`Connecting to ${ui.style.dim(fullConfig.rpcUrl)}...`);
  spinner.start();

  const publicClient = createPublicClient({ transport: http(fullConfig.rpcUrl) });

  let chainId: number;
  try {
    chainId = await publicClient.getChainId();
    spinner.stop(`Connected to chain ID: ${ui.style.value(chainId)}`, true);

    const blockNumber = await publicClient.getBlockNumber();
    ui.printKeyValue('Current block', Number(blockNumber), 3);
  } catch (err) {
    spinner.stop(`Failed to connect: ${err instanceof Error ? err.message : String(err)}`, false);
    console.log(`\n${ui.colors.dim}Make sure the Nitro dev node is running:${ui.colors.reset}`);
    console.log(`  ${ui.style.highlight('cd nitro-devnode && ./run-dev-node.sh')}`);
    throw err;
  }

  const chain = {
    id: chainId,
    name: 'Custom',
    network: 'custom',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [fullConfig.rpcUrl] } },
  } as const;

  // Setup funder account
  const funderAccount = privateKeyToAccount(fullConfig.funderPrivateKey as Hex);
  const walletClient = createWalletClient({
    account: funderAccount,
    chain: chain as any,
    transport: http(fullConfig.rpcUrl),
  });
  const funderBalance = await publicClient.getBalance({ address: funderAccount.address });
  console.log();
  ui.printKeyValue('Funder', funderAccount.address, 3);
  ui.printKeyValue('Balance', `${formatEther(funderBalance)} ETH`, 3);

  // Setup contracts if needed (Token, Uniswap)
  const contracts = await setupContracts(fullConfig, publicClient, walletClient, funderAccount);
  fullConfig.contracts = contracts;

  // Create and fund sender accounts (with tokens and approvals if needed)
  const senders = await createAndFundSenders(
    publicClient,
    funderAccount,
    chainId,
    fullConfig.senderCount,
    fullConfig,
    contracts,
  );

  if (senders.length === 0) {
    throw new Error('No sender accounts available');
  }

  // Small delay to ensure all setup transactions are fully processed
  await sleep(1000);

  // Prepare and pre-sign all transactions
  const { unsignedTxs } = await generatePayload({
    senders,
    publicClient,
    chainId,
    config: fullConfig,
    contracts,
  });

  if (unsignedTxs.length === 0) {
    throw new Error('No transactions were generated');
  }

  const { signedTxs, signDuration } = await signTransactions(unsignedTxs);

  if (signedTxs.length === 0) {
    throw new Error('No transactions were signed successfully');
  }

  // Fire-and-forget broadcast pre-signed transactions
  const broadcastStartTime = Date.now();
  const sendResult = await fireAndForgetBroadcast(signedTxs, fullConfig);
  const broadcastEndTime = Date.now();
  sendResult.signDuration = signDuration;

  if (sendResult.txHashes.length === 0) {
    throw new Error('No transactions were broadcast successfully');
  }

  // Wait for confirmations
  const confirmResult = await waitForConfirmations(publicClient, sendResult.txHashes);

  // Analyze TPS from chain
  const tpsAnalysis = await analyzeBlockTPS(
    publicClient,
    confirmResult.receipts,
    broadcastStartTime,
    broadcastEndTime,
    sendResult.txHashes,
  );

  // Generate report
  generateReport(fullConfig, sendResult, confirmResult, tpsAnalysis);
}

export default {
  runTpsTest,
  DEFAULT_TPS_CONFIG,
};
