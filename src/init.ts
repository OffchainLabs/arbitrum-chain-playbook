import fs from 'fs';
import inquirer from 'inquirer';
import { createPublicClient, http } from 'viem';
import { getParentChain } from './utils/parentChain.js';
import logger from './utils/logger.js';
import { ChainEnv } from './state/chainEnv/index.js';
import { SendersEnv, SenderRole } from './state/sendersEnv/index.js';
import { loadChainFromTxHash } from './state/chainEnv/fromTxHash.js';
import { getNodeConfigPath } from './utils/nodeConfigUtils.js';
import { parseDeploymentTx } from './utils/deploymentTx.js';
import { config } from './config/index.js';

export function initializeApp(): void {
  const sendersEnv = SendersEnv.getInstance();
  const chainEnv = ChainEnv.getInstance();

  chainEnv.setChainModeAvailable(config.isChainModeAvailable());
  chainEnv.setRemoteRpcModeAvailable(config.isRemoteRpcModeAvailable());

  if (config.hasDeployerKey()) {
    sendersEnv.addByPrivateKey(config.app.deployerPrivateKey!, SenderRole.RegularSender);
  } else {
    logger.warn('MAIN_PRIVATE_KEY is not set. Deploy and demo operations will be unavailable.');
    logger.raw('  How to fix: Add MAIN_PRIVATE_KEY=<your-private-key> to your .env file.');
  }
}

export interface InitializeChainModeOptions {
  // Headless mode: forbid any interactive prompt. If a chain-id mismatch
  // between node-config.json and the deployment tx hash is detected, the
  // function throws so the script runner can surface a clear error.
  headless?: boolean;
  // Headless-only restore policy. "fresh" skips existing deployment restore so
  // commands that redeploy their own chain are not blocked by stale local state.
  restorePolicy?: 'auto' | 'fresh' | 'reuse';
}

export async function initializeChainMode(opts: InitializeChainModeOptions = {}): Promise<void> {
  const hasTxHash = !!config.app.deploymentTxHash;
  const hasNodeConfig = fs.existsSync(getNodeConfigPath());
  const hasParentChainRpc = !!config.app.parentChainRpc;

  const chainEnv = ChainEnv.getInstance();

  if (hasParentChainRpc) {
    const parentChainPublicClient = createPublicClient({
      chain: getParentChain(),
      transport: http(config.app.parentChainRpc),
    });
    chainEnv.setParentChainClient(parentChainPublicClient);
    logger.info(`Using parent chain RPC: ${config.app.parentChainRpc}`);
  } else if (hasTxHash) {
    logger.warn('PARENT_CHAIN_RPC is not set. Chain mode is disabled.');
  }

  if (opts.restorePolicy === 'fresh') {
    logger.info('Skipping existing chain restore for fresh headless run.');
    return;
  }

  if (hasTxHash && hasNodeConfig && hasParentChainRpc) {
    const txChainId = await fetchChainIdFromTxHash();
    const configChainId = readChainIdFromNodeConfig();

    if (txChainId === configChainId) {
      const result = await loadChainFromTxHash();
      chainEnv.setDeploymentResult(result.chainConfig, result.nodeConfig, result.coreContracts, result.nodeConfigPaths);
      await discoverExistingContainersOnInit(chainEnv);
      return;
    }

    if (opts.headless) {
      throw new Error(
        `node-config.json chain-id (${configChainId}) does not match CHAIN_DEPLOYMENT_TRANSACTION_HASH chainId (${txChainId}). ` +
          'Refusing to overwrite in headless mode. Delete node-config.json, fix the env var, or run the interactive CLI to confirm.',
      );
    }

    const confirmed = await confirmOverwrite(configChainId, txChainId);
    if (confirmed) {
      const result = await loadChainFromTxHash();
      chainEnv.setDeploymentResult(result.chainConfig, result.nodeConfig, result.coreContracts, result.nodeConfigPaths);
      await discoverExistingContainersOnInit(chainEnv);
    } else {
      logger.info('Skipped chain initialization. Entering menu.');
    }
    return;
  }

  if (hasTxHash && !hasNodeConfig && hasParentChainRpc) {
    const result = await loadChainFromTxHash();
    chainEnv.setDeploymentResult(result.chainConfig, result.nodeConfig, result.coreContracts, result.nodeConfigPaths);
    await discoverExistingContainersOnInit(chainEnv);
  }
}

async function discoverExistingContainersOnInit(chainEnv: ChainEnv): Promise<void> {
  if (!chainEnv.status.isInitiated()) return;
  const nodeManager = chainEnv.nodeManager;
  if (!nodeManager) return;
  await nodeManager.discoverExistingContainers();
}

async function fetchChainIdFromTxHash(): Promise<bigint> {
  const txHash = config.getDeploymentTxHash();
  if (!txHash) {
    throw new Error('Deployment transaction hash is not configured.');
  }

  const chainEnv = ChainEnv.getInstance();
  const parentChainPublicClient = chainEnv.parentChainClient;
  if (!parentChainPublicClient) {
    throw new Error('Parent chain client is not initialized.');
  }

  const { chainConfig } = await parseDeploymentTx(parentChainPublicClient, txHash);
  return BigInt(chainConfig.chainId);
}

function readChainIdFromNodeConfig(): bigint {
  const nodeConfigPath = getNodeConfigPath();
  const content = fs.readFileSync(nodeConfigPath, 'utf-8');
  const nodeConfig = JSON.parse(content);
  const infoRaw = nodeConfig?.chain?.['info-json'];
  if (typeof infoRaw !== 'string' || infoRaw.trim() === '') {
    throw new Error('Invalid node-config.json: missing chain.info-json');
  }

  const parsed = JSON.parse(infoRaw);
  const items = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of items) {
    const chainIdValue = item?.['chain-id'] ?? item?.chainId;
    if (chainIdValue !== undefined && chainIdValue !== null) {
      return BigInt(chainIdValue);
    }
  }

  throw new Error('Invalid node-config.json: chain-id not found in chain.info-json');
}

async function confirmOverwrite(configChainId: bigint, txChainId: bigint): Promise<boolean> {
  const { overwrite } = await inquirer.prompt<{ overwrite: boolean }>([
    {
      type: 'confirm',
      name: 'overwrite',
      message: `node-config.json chain-id (${configChainId}) does not match tx hash chainId (${txChainId}). Continue might overwrite node-config.json (node-config.json chain-id will be updated to tx hash chain-id), continue?`,
      default: false,
    },
  ]);
  return overwrite;
}
