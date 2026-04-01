import {
  encodeFunctionData,
  formatUnits,
  parseAbi,
  parseEther,
  parseUnits,
  type PublicClient,
  type TransactionSerializable,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  TxType,
  TxMix,
  TpsTestConfig,
  ContractAddresses,
  UnsignedTxWithMeta,
  SignedTxWithMeta,
  ExpectedTxDetails,
  GasParams,
  FundingNeeds,
} from './types.js';
import { formatDuration } from './ui.js';

/**
 * Payload Generator for TPS Testing (viem)
 *
 * Supports multiple transaction types:
 * - ETH transfers
 * - ERC20 token transfers
 * - Uniswap swaps (ETH <-> Token)
 */

// =============================================================================
// Standard ABIs
// =============================================================================

export const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

export const ROUTER_ABI = parseAbi([
  'function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) payable returns (uint[] amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)',
  'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)',
  'function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) payable returns (uint amountToken, uint amountETH, uint liquidity)',
]);

// =============================================================================
// Parse Transaction Mix
// =============================================================================

/**
 * Parse transaction mix from string "eth:token:swap" percentages
 */
export function parseTxMix(mixString: string): TxMix {
  if (!mixString) {
    return { ethTransfer: 100, tokenTransfer: 0, swap: 0 };
  }

  const parts = mixString.split(':').map((p) => parseInt(p.trim()) || 0);
  const [eth = 100, token = 0, swap = 0] = parts;

  const total = eth + token + swap;
  if (total !== 100) {
    console.warn(`⚠️  Transaction mix doesn't sum to 100% (${total}%), normalizing...`);
  }

  return {
    ethTransfer: Math.round((eth / total) * 100),
    tokenTransfer: Math.round((token / total) * 100),
    swap: Math.round((swap / total) * 100),
  };
}

/**
 * Determine which contracts need to be deployed based on tx mix
 */
export function getRequiredContracts(txMix: TxMix): { needsToken: boolean; needsUniswap: boolean } {
  return {
    needsToken: txMix.tokenTransfer > 0 || txMix.swap > 0,
    needsUniswap: txMix.swap > 0,
  };
}

// =============================================================================
// ETH Transfer Generator
// =============================================================================

function generateEthTransferTx(
  nonce: number,
  recipient: `0x${string}`,
  value: bigint,
  gasParams: GasParams,
  chainId: number,
  gasLimit: bigint,
): Record<string, unknown> {
  return {
    to: recipient,
    value: value,
    nonce: nonce,
    gas: gasLimit,
    chainId: chainId,
    type: 'eip1559' as const,
    maxFeePerGas: gasParams.maxFeePerGas,
    maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas,
  };
}

// =============================================================================
// Token Transfer Generator
// =============================================================================

function generateTokenTransferTx(
  nonce: number,
  tokenAddress: `0x${string}`,
  recipient: `0x${string}`,
  amount: bigint,
  gasParams: GasParams,
  chainId: number,
  gasLimit: bigint,
): Record<string, unknown> {
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [recipient, amount],
  });

  return {
    to: tokenAddress,
    value: 0n,
    data: data,
    nonce: nonce,
    gas: gasLimit,
    chainId: chainId,
    type: 'eip1559' as const,
    maxFeePerGas: gasParams.maxFeePerGas,
    maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas,
  };
}

// =============================================================================
// Swap Generator
// =============================================================================

function generateSwapTx(
  sender: PrivateKeyAccount,
  nonce: number,
  routerAddress: `0x${string}`,
  wethAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
  ethAmount: bigint,
  gasParams: GasParams,
  chainId: number,
  gasLimit: bigint,
): Record<string, unknown> {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour
  const path: readonly `0x${string}`[] = [wethAddress, tokenAddress];

  const data = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: 'swapExactETHForTokens',
    args: [
      0n, // amountOutMin - accept any amount for stress testing
      path,
      sender.address,
      deadline,
    ],
  });

  return {
    to: routerAddress,
    value: ethAmount,
    data: data,
    nonce: nonce,
    gas: gasLimit,
    chainId: chainId,
    type: 'eip1559' as const,
    maxFeePerGas: gasParams.maxFeePerGas,
    maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas,
  };
}

// =============================================================================
// Mixed Payload Generator
// =============================================================================

interface GeneratePayloadOptions {
  senders: PrivateKeyAccount[];
  publicClient: PublicClient;
  chainId: number;
  config: TpsTestConfig;
  contracts?: ContractAddresses;
}

interface GeneratePayloadResult {
  unsignedTxs: UnsignedTxWithMeta[];
  expectedTxDetails: ExpectedTxDetails;
}

/**
 * Generate mixed transaction payloads
 */
export async function generatePayload(options: GeneratePayloadOptions): Promise<GeneratePayloadResult> {
  const { senders, publicClient, chainId, config, contracts = {} as ContractAddresses } = options;
  const txMix = config.txMix || { ethTransfer: 100, tokenTransfer: 0, swap: 0 };

  console.log(`\n🔧 Generating ${config.txCount} transactions...`);
  console.log(`   Mix: ${txMix.ethTransfer}% ETH | ${txMix.tokenTransfer}% Token | ${txMix.swap}% Swap`);

  // Calculate counts for each type
  const ethCount = Math.floor((config.txCount * txMix.ethTransfer) / 100);
  const tokenCount = Math.floor((config.txCount * txMix.tokenTransfer) / 100);
  const swapCount = config.txCount - ethCount - tokenCount;

  console.log(`   ETH transfers: ${ethCount}`);
  console.log(`   Token transfers: ${tokenCount}`);
  console.log(`   Swaps: ${swapCount}`);

  // Validate contracts are available for the required tx types
  if (tokenCount > 0 && !contracts.token) {
    throw new Error('Token address required for token transfers');
  }
  if (swapCount > 0 && (!contracts.router || !contracts.weth || !contracts.token)) {
    throw new Error('Router, WETH, and Token addresses required for swaps');
  }

  // Get nonces for all senders in parallel
  const noncePromises = senders.map((s) =>
    publicClient.getTransactionCount({ address: s.address, blockTag: 'pending' }),
  );
  const nonces = await Promise.all(noncePromises);
  const senderNonces = new Map(senders.map((s, i) => [s.address, nonces[i]]));

  // Get current fee data
  const feeData = await publicClient.estimateFeesPerGas();
  const gasPrice = await publicClient.getGasPrice();
  const multiplier = BigInt(Math.floor((config.gasMultiplier || 2) * 100));
  const gasParams: GasParams = {
    maxFeePerGas: ((feeData.maxFeePerGas ?? gasPrice) * multiplier) / 100n,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 0n,
  };

  console.log(`   Gas price: ${formatUnits(gasPrice, 9)} gwei (using ${config.gasMultiplier || 2}x buffer)`);

  // Create recipient addresses
  const ethRecipient = privateKeyToAccount(generatePrivateKey()).address;
  const tokenRecipient = privateKeyToAccount(generatePrivateKey()).address;

  // Transaction values (1 wei default for ETH transfers and swaps)
  const ethValue = parseEther(config.txValue || '0.000000000000000001');
  const tokenAmount = parseUnits(config.tokenTxValue || '100', 18);
  const swapEthAmount = parseEther(config.swapValue || '0.000000000000000001');

  console.log(`   ETH value: ${config.txValue || '1 wei'} per transfer`);
  if (tokenCount > 0) console.log(`   Token value: ${config.tokenTxValue || '100'} tokens per transfer`);
  if (swapCount > 0) console.log(`   Swap value: ${config.swapValue || '1 wei'} per swap`);

  // Estimate gas for each transaction type dynamically
  let ethTransferGasLimit = BigInt(config.gasLimit || 100000); // fallback
  let tokenTransferGasLimit = 100000n; // fallback
  let swapGasLimit = 200000n; // fallback

  console.log(`   Estimating gas for transaction types...`);

  // Estimate ETH transfer gas
  if (ethCount > 0 && senders.length > 0) {
    try {
      const estimated = await publicClient.estimateGas({
        account: senders[0].address,
        to: ethRecipient,
        value: ethValue,
      });
      ethTransferGasLimit = (estimated * 150n) / 100n; // 1.5x buffer
      console.log(`   ETH transfer gas: ${estimated} (using ${ethTransferGasLimit} with 1.5x buffer)`);
    } catch {
      console.log(`   ETH transfer gas estimation failed, using fallback: ${ethTransferGasLimit}`);
    }
  }

  // Estimate token transfer gas
  if (tokenCount > 0 && contracts.token && senders.length > 0) {
    try {
      const data = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [tokenRecipient, tokenAmount],
      });
      const estimated = await publicClient.estimateGas({
        account: senders[0].address,
        to: contracts.token as `0x${string}`,
        data: data,
      });
      tokenTransferGasLimit = (estimated * 150n) / 100n; // 1.5x buffer
      console.log(`   Token transfer gas: ${estimated} (using ${tokenTransferGasLimit} with 1.5x buffer)`);
    } catch {
      console.log(`   Token transfer gas estimation failed, using fallback: ${tokenTransferGasLimit}`);
    }
  }

  // Estimate swap gas
  if (swapCount > 0 && contracts.router && contracts.weth && contracts.token && senders.length > 0) {
    try {
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const path: readonly `0x${string}`[] = [contracts.weth as `0x${string}`, contracts.token as `0x${string}`];
      const swapData = encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: 'swapExactETHForTokens',
        args: [0n, path, senders[0].address, deadline],
      });
      const estimated = await publicClient.estimateGas({
        account: senders[0].address,
        to: contracts.router as `0x${string}`,
        data: swapData,
        value: swapEthAmount,
      });
      swapGasLimit = (estimated * 150n) / 100n; // 1.5x buffer
      console.log(`   Swap gas: ${estimated} (using ${swapGasLimit} with 1.5x buffer)`);
    } catch {
      console.log(`   Swap gas estimation failed, using fallback: ${swapGasLimit}`);
    }
  }

  // Build transaction assignment list (interleaved for better distribution)
  const txAssignments: TxType[] = [];

  let ethRemaining = ethCount;
  let tokenRemaining = tokenCount;
  let swapRemaining = swapCount;

  while (ethRemaining > 0 || tokenRemaining > 0 || swapRemaining > 0) {
    if (ethRemaining > 0) {
      txAssignments.push(TxType.ETH_TRANSFER);
      ethRemaining--;
    }
    if (tokenRemaining > 0) {
      txAssignments.push(TxType.TOKEN_TRANSFER);
      tokenRemaining--;
    }
    if (swapRemaining > 0) {
      txAssignments.push(TxType.SWAP);
      swapRemaining--;
    }
  }

  // Build unsigned transactions
  const unsignedTxs: UnsignedTxWithMeta[] = [];

  for (let i = 0; i < txAssignments.length; i++) {
    const txType = txAssignments[i];
    const senderIdx = i % senders.length;
    const sender = senders[senderIdx];
    const nonce = senderNonces.get(sender.address)!;
    senderNonces.set(sender.address, nonce + 1);

    let tx: TransactionSerializable;

    switch (txType) {
      case TxType.ETH_TRANSFER:
        tx = generateEthTransferTx(nonce, ethRecipient, ethValue, gasParams, chainId, ethTransferGasLimit);
        break;

      case TxType.TOKEN_TRANSFER:
        tx = generateTokenTransferTx(
          nonce,
          contracts.token! as `0x${string}`,
          tokenRecipient,
          tokenAmount,
          gasParams,
          chainId,
          tokenTransferGasLimit,
        );
        break;

      case TxType.SWAP:
        tx = generateSwapTx(
          sender,
          nonce,
          contracts.router! as `0x${string}`,
          contracts.weth! as `0x${string}`,
          contracts.token! as `0x${string}`,
          swapEthAmount,
          gasParams,
          chainId,
          swapGasLimit,
        );
        break;
    }

    unsignedTxs.push({
      sender,
      tx,
      index: i,
      txType,
    });
  }

  // Build expected tx details for verification
  const expectedTxDetails: ExpectedTxDetails = {
    senderAddresses: new Set(senders.map((s) => s.address.toLowerCase())),
    txMix,
    counts: { ethCount, tokenCount, swapCount },
    recipients: {
      eth: ethRecipient.toLowerCase(),
      token: tokenRecipient.toLowerCase(),
    },
    contracts: {
      token: contracts.token?.toLowerCase(),
      router: contracts.router?.toLowerCase(),
      weth: contracts.weth?.toLowerCase(),
    },
  };

  console.log(`✅ Generated ${unsignedTxs.length} transactions across ${senders.length} senders`);

  return { unsignedTxs, expectedTxDetails };
}

// =============================================================================
// Transaction Signing
// =============================================================================

interface SignTransactionsResult {
  signedTxs: SignedTxWithMeta[];
  signDuration: number;
}

/**
 * Pre-sign all transactions
 */
export async function signTransactions(unsignedTxs: UnsignedTxWithMeta[]): Promise<SignTransactionsResult> {
  console.log(`\n✍️  Pre-signing ${unsignedTxs.length} transactions...`);
  const signStartTime = Date.now();

  const signedTxs: SignedTxWithMeta[] = [];
  const signBatchSize = 100;

  for (let i = 0; i < unsignedTxs.length; i += signBatchSize) {
    const batch = unsignedTxs.slice(i, i + signBatchSize);

    const signPromises = batch.map(async ({ sender, tx, index, txType }) => {
      try {
        const signedTx = await sender.signTransaction(tx);
        return { signedTx, index, expectedFrom: sender.address.toLowerCase(), txType };
      } catch (err) {
        console.error(`\n   Failed to sign tx ${index}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    });

    const results = await Promise.all(signPromises);

    for (const result of results) {
      if (result) signedTxs.push(result);
    }

    // Progress update
    const progress = Math.min(i + signBatchSize, unsignedTxs.length);
    const elapsed = Date.now() - signStartTime;
    const rate = (progress / elapsed) * 1000;
    process.stdout.write(`\r   Signed: ${progress}/${unsignedTxs.length} (${rate.toFixed(0)} tx/s)`);
  }

  const signDuration = Date.now() - signStartTime;
  console.log(`\n✅ Pre-signed ${signedTxs.length} transactions in ${formatDuration(signDuration)}`);

  return { signedTxs, signDuration };
}

// =============================================================================
// Funding Calculator
// =============================================================================

/**
 * Calculate how much ETH and tokens each sender needs
 * Uses real-time gas price and gas estimation from chain
 */
export async function calculateFundingNeeds(
  config: TpsTestConfig,
  senderCount: number,
  publicClient: PublicClient,
  sampleAddress?: `0x${string}`,
): Promise<FundingNeeds> {
  const txMix = config.txMix || { ethTransfer: 100, tokenTransfer: 0, swap: 0 };
  const txPerSender = Math.ceil(config.txCount / senderCount);

  // Calculate tx counts per sender for each type
  const ethTransfersPerSender = Math.ceil((txPerSender * txMix.ethTransfer) / 100);
  const swapsPerSender = Math.ceil((txPerSender * txMix.swap) / 100);
  const tokenTransfersPerSender = Math.ceil((txPerSender * txMix.tokenTransfer) / 100);

  // ETH value per transfer (1 wei default)
  const ethValue = parseEther(config.txValue || '0.000000000000000001');
  // ETH value per swap (1 wei default)
  const swapValue = parseEther(config.swapValue || '0.000000000000000001');

  // Fetch real-time gas price from chain
  const baseGasPrice = await publicClient.getGasPrice();
  // Apply multiplier for safety margin
  const gasPrice = baseGasPrice * BigInt(config.gasMultiplier || 4);

  // Dynamically estimate gas for ETH transfer using sample transaction
  let ethTransferGas = 100000n; // fallback
  if (sampleAddress) {
    try {
      const dummyRecipient = privateKeyToAccount(generatePrivateKey()).address;
      const estimated = await publicClient.estimateGas({
        account: sampleAddress,
        to: dummyRecipient,
        value: ethValue,
      });
      ethTransferGas = (estimated * 150n) / 100n; // 1.5x buffer
    } catch {
      // Use fallback if estimation fails
    }
  }

  // Use conservative estimates for token and swap (will be re-estimated in generatePayload)
  const tokenTransferGas = 100000n;
  const swapGas = 200000n;

  // Calculate ETH needed for transfers
  const ethForTransfers = ethValue * BigInt(ethTransfersPerSender);
  // Calculate ETH needed for swaps
  const ethForSwaps = swapValue * BigInt(swapsPerSender);
  // Calculate ETH needed for gas fees
  const totalGasUnits =
    ethTransferGas * BigInt(ethTransfersPerSender) +
    tokenTransferGas * BigInt(tokenTransfersPerSender) +
    swapGas * BigInt(swapsPerSender);
  const ethForGas = gasPrice * totalGasUnits;

  // Total ETH per sender with 10% buffer
  const ethBase = ethForTransfers + ethForSwaps + ethForGas;
  const ethPerSender = (ethBase * 110n) / 100n;

  // Token needs: transfers only with 10% buffer
  const tokenAmount = parseUnits(config.tokenTxValue || '100', 18);
  const tokenBase = tokenAmount * BigInt(tokenTransfersPerSender);
  const tokensPerSender = (tokenBase * 110n) / 100n;

  return {
    ethPerSender,
    tokensPerSender,
    breakdown: {
      ethTransfersPerSender,
      tokenTransfersPerSender,
      swapsPerSender,
    },
  };
}

export default {
  ERC20_ABI,
  ROUTER_ABI,
  parseTxMix,
  getRequiredContracts,
  generatePayload,
  signTransactions,
  calculateFundingNeeds,
};
