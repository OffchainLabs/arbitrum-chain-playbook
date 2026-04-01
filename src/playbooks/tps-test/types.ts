import type { TransactionReceipt, TransactionSerializable } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';

/**
 * TPS Test Configuration
 */
export interface TpsTestConfig {
  // RPC URL
  rpcUrl: string;

  // Pre-funded dev account private key
  funderPrivateKey: string;

  // Test parameters
  txCount: number;
  senderCount: number;
  txValue: string;
  fundingAmount: string;

  // Token/Swap specific values
  tokenTxValue: string;
  swapValue: string;

  // Gas settings
  gasLimit: number;
  concurrentRequests: number;
  gasMultiplier: number;

  // Transaction mix
  txMix: TxMix;

  // Verification
  verifyAll: boolean;

  // Interactive mode
  interactive?: boolean;

  // Contract addresses
  contracts: ContractAddresses;
}

/**
 * Transaction mix percentages
 */
export interface TxMix {
  ethTransfer: number;
  tokenTransfer: number;
  swap: number;
}

/**
 * Deployed contract addresses
 */
export interface ContractAddresses {
  token: string | null;
  weth: string | null;
  router: string | null;
  factory: string | null;
  pair: string | null;
}

/**
 * Transaction types
 */
export enum TxType {
  ETH_TRANSFER = 'eth_transfer',
  TOKEN_TRANSFER = 'token_transfer',
  SWAP = 'swap',
}

/**
 * Unsigned transaction with metadata
 */
export interface UnsignedTxWithMeta {
  sender: PrivateKeyAccount;
  tx: TransactionSerializable;
  index: number;
  txType: TxType;
}

/**
 * Signed transaction with metadata
 */
export interface SignedTxWithMeta {
  signedTx: string;
  index: number;
  expectedFrom: string;
  txType: TxType;
}

/**
 * Transaction hash with metadata
 */
export interface TxHashWithMeta {
  hash: string;
  index: number;
  expectedFrom: string;
  txType: TxType;
}

/**
 * Expected transaction details for verification
 */
export interface ExpectedTxDetails {
  senderAddresses: Set<string>;
  txMix: TxMix;
  counts: {
    ethCount: number;
    tokenCount: number;
    swapCount: number;
  };
  recipients: {
    eth: string;
    token: string;
  };
  contracts: {
    token?: string;
    router?: string;
    weth?: string;
  };
}

/**
 * Broadcast result
 */
export interface BroadcastResult {
  txHashes: TxHashWithMeta[];
  successCount: number;
  errorCount: number;
  firstError: string | null;
  broadcastDuration: number;
  errorTypes: Record<string, number>;
  signDuration?: number;
}

/**
 * Confirmation result
 */
export interface ConfirmResult {
  receipts: TransactionReceipt[];
  confirmDuration: number;
}

/**
 * Block statistics
 */
export interface BlockStats {
  number: number;
  timestamp: number;
  totalTxCount: number;
  ourTxCount: number;
  gasUsed: bigint;
}

/**
 * TPS analysis result
 */
export interface TpsAnalysis {
  blockCount: number;
  firstBlock: number;
  lastBlock: number;
  blockTimeSpanSeconds: number;
  actualTimeSpanSeconds: number;
  avgBlockTime: number;
  totalBlockTxCount: number;
  ourTxCount: number;
  verifiedTxCount: number;
  verifiedSuccessfulCount: number;
  revertedTxCount: number;
  receiptsCount: number;
  sampleVerified: number;
  sampleSize: number;
  blockBasedTps: number;
  broadcastTps: number;
  confirmedBlockTps: number;
  confirmedBroadcastTps: number;
  peakBlock: BlockStats;
  blockStats: BlockStats[];
  verifiedByType: Record<string, number>;
}

/**
 * Gas parameters (using bigint)
 */
export interface GasParams {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * Funding needs calculation (using bigint)
 */
export interface FundingNeeds {
  ethPerSender: bigint;
  tokensPerSender: bigint;
  breakdown: {
    ethTransfersPerSender: number;
    tokenTransfersPerSender: number;
    swapsPerSender: number;
  };
}

/**
 * Token deployment config
 */
export interface TokenDeployConfig {
  rpcUrl: string;
  deployerPrivateKey: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimals: number;
  initialSupply: string;
}

/**
 * Token deployment result
 */
export interface TokenDeployResult {
  contractAddress: string;
  abi: unknown[];
  tokenName: string;
  tokenSymbol: string;
  tokenDecimals: number;
  totalSupply: string;
  deployer: string;
}

/**
 * Uniswap deployment config
 */
export interface UniswapDeployConfig {
  rpcUrl: string;
  deployerPrivateKey: string;
}

/**
 * Uniswap deployment result
 */
export interface UniswapDeployResult {
  weth: {
    address: string;
    abi: unknown[];
  };
  factory: {
    address: string;
    abi: unknown[];
  };
  router: {
    address: string;
    abi: unknown[];
  };
  deployer: string;
}

/**
 * DEX setup config
 */
export interface DexSetupConfig {
  rpcUrl: string;
  deployerPrivateKey: string;
  token: {
    name: string;
    symbol: string;
    decimals: number;
    initialSupply: string;
  };
  liquidity: {
    ethAmount: string;
    tokenAmount: string;
  };
}

/**
 * DEX setup result
 */
export interface DexSetupResult {
  token: {
    address: string;
    abi: unknown[];
    name: string;
    symbol: string;
    decimals: number;
  };
  weth: {
    address: string;
  };
  factory: {
    address: string;
    abi: unknown[];
  };
  router: {
    address: string;
    abi: unknown[];
  };
  pair: {
    address: string;
  };
  deployer: string;
}
