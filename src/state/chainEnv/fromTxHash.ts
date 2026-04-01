/**
 * Chain reconstruction from deployment transaction hash
 *
 * Uses @arbitrum/chain-sdk to:
 * - Fetch rollup deployment tx + receipt
 * - Extract chainConfig and coreContracts (SDK types)
 * - Regenerate node-config.json via prepareNodeConfig
 *
 * All comments are in English by requirement.
 */

import { writeFile } from 'fs/promises';
import {
  ChainConfig,
  CoreContracts,
  PrepareNodeConfigParams,
  createRollupPrepareTransaction,
  createRollupPrepareTransactionReceipt,
  prepareNodeConfig,
  NodeConfig,
} from '@arbitrum/chain-sdk';
import { getParentChainLayer } from '@arbitrum/chain-sdk/utils';
import logger from '../../utils/logger.js';
import { createDefaultNodeConfigPaths, getNodeConfigFilePath } from './persistence.js';
import { NodeConfigPaths } from './types.js';
import { DEFAULT_CHAIN_NAME } from '../../types/constants.js';
import SendersEnv, { SenderRole } from '../sendersEnv/index.js';
import ChainEnv from './index.js';
import { applyGeneratedNodeConfigDefaults } from '../../utils/nodeConfigUtils.js';

export interface TxHashReconstructionResult {
  chainConfig: ChainConfig;
  nodeConfig: NodeConfig;
  coreContracts: CoreContracts;
  nodeConfigPaths: NodeConfigPaths;
}

/**
 * Validate required environment variables for reconstruction.
 */
function validateEnv(): void {
  if (!process.env.CHAIN_DEPLOYMENT_TRANSACTION_HASH) {
    throw new Error('Missing CHAIN_DEPLOYMENT_TRANSACTION_HASH in environment.');
  }
  if (!process.env.BATCH_POSTER_PRIVATE_KEY) {
    throw new Error('Missing BATCH_POSTER_PRIVATE_KEY in environment.');
  }
  if (!process.env.VALIDATOR_PRIVATE_KEY) {
    throw new Error('Missing VALIDATOR_PRIVATE_KEY in environment.');
  }
  if (!process.env.PARENT_CHAIN_RPC) {
    throw new Error('Missing PARENT_CHAIN_RPC in environment.');
  }
}

/**
 * Reconstruct chain data from deployment transaction hash.
 */
export async function loadChainFromTxHash(): Promise<TxHashReconstructionResult> {
  validateEnv();

  const txHash = process.env.CHAIN_DEPLOYMENT_TRANSACTION_HASH as `0x${string}`;
  const chainEnv = ChainEnv.getInstance();
  const parentChainPublicClient = chainEnv.parentChainClient!;
  const parentChain = parentChainPublicClient?.chain!;

  const tx = createRollupPrepareTransaction(await parentChainPublicClient.getTransaction({ hash: txHash }));
  const txReceipt = createRollupPrepareTransactionReceipt(
    await parentChainPublicClient.getTransactionReceipt({ hash: txHash }),
  );

  const config = tx.getInputs()[0].config;
  const chainConfig: ChainConfig = JSON.parse(config.chainConfig);
  const coreContracts: CoreContracts = txReceipt.getCoreContracts();

  const nodeConfigParameters: PrepareNodeConfigParams = {
    chainName: DEFAULT_CHAIN_NAME,
    chainConfig,
    coreContracts,
    batchPosterPrivateKey: process.env.BATCH_POSTER_PRIVATE_KEY as `0x${string}`,
    validatorPrivateKey: process.env.VALIDATOR_PRIVATE_KEY as `0x${string}`,
    stakeToken: config.stakeToken,
    parentChainId: parentChain.id as 1 | 1337 | 412346 | 42161 | 42170 | 8453 | 11155111 | 421614 | 84532, // Chain-sdk only supports these parent chain ids
    parentChainRpcUrl: parentChain.rpcUrls.default.http[0],
  };

  const sendersEnv = SendersEnv.getInstance();
  sendersEnv.addByPrivateKey(process.env.BATCH_POSTER_PRIVATE_KEY as `0x${string}`, SenderRole.BatchPoster);
  sendersEnv.addByPrivateKey(process.env.VALIDATOR_PRIVATE_KEY as `0x${string}`, SenderRole.Validator);

  // For L2 chains settling to Ethereum mainnet or testnet （should not be needed as we are using Arbitrum Sepolia as parent chain only）
  if (getParentChainLayer(parentChainPublicClient.chain!.id as any) === 1) {
    const beaconRpc = process.env.ETHEREUM_BEACON_RPC_URL;
    if (!beaconRpc) {
      throw new Error('Missing ETHEREUM_BEACON_RPC_URL for L2 chains.');
    }
    nodeConfigParameters.parentChainBeaconRpcUrl = beaconRpc;
  }

  const nodeConfig = applyGeneratedNodeConfigDefaults(prepareNodeConfig(nodeConfigParameters));

  // Disable rollup deployment check (already deployed via tx hash)
  nodeConfig['ensure-rollup-deployment'] = false;

  // Persist main node-config.json
  const nodeConfigPath = getNodeConfigFilePath();
  await writeFile(nodeConfigPath, JSON.stringify(nodeConfig, null, 2));
  logger.success(`Node config written to "${nodeConfigPath}"`);

  // Build nodeConfigPaths map (main only for now)
  const nodeConfigPaths: NodeConfigPaths = createDefaultNodeConfigPaths();

  chainEnv.setDeploymentResult(chainConfig, nodeConfig, coreContracts, nodeConfigPaths);

  return { chainConfig, nodeConfig, coreContracts, nodeConfigPaths };
}
