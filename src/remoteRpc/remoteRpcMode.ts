import { createPublicClient, http } from 'viem';
import { getParentChain } from '../utils/parentChain.js';
import { ChainConfig, CoreContracts } from '@arbitrum/chain-sdk';
import { ChainEnv } from '../state/chainEnv/index.js';
import { NodeManager } from '../core/docker/nodeManager.js';
import { OperationMode } from '../types/index.js';
import logger from '../utils/logger.js';
import { parseDeploymentTx } from '../utils/deploymentTx.js';
import { RemoteRpcConfig, setRemoteRpcConfig } from './remoteRpcConfig.js';

function validateEnvVars(): RemoteRpcConfig | null {
  const deploymentTxHash = process.env.CHAIN_DEPLOYMENT_TRANSACTION_HASH;
  const parentChainRpc = process.env.PARENT_CHAIN_RPC;
  const chainRpc = process.env.CHAIN_RPC;

  if (!deploymentTxHash || !parentChainRpc || !chainRpc) {
    const missing: string[] = [];
    if (!parentChainRpc) missing.push('PARENT_CHAIN_RPC');
    if (!deploymentTxHash) missing.push('CHAIN_DEPLOYMENT_TRANSACTION_HASH');
    if (!chainRpc) missing.push('CHAIN_RPC');
    logger.errorWithFix(
      `Missing required environment variables for Remote RPC mode: ${missing.join(', ')}`,
      `Add the missing variable(s) to your .env file:\n${missing.map((v) => `    ${v}=<value>`).join('\n')}`,
    );
    return null;
  }

  return {
    deploymentTxHash: deploymentTxHash as `0x${string}`,
    parentChainRpc,
    chainRpc,
  };
}

async function loadChainFromRemoteTxHash(
  config: RemoteRpcConfig,
): Promise<{ chainConfig: ChainConfig; coreContracts: CoreContracts }> {
  logger.info('Fetching chain configuration from deployment transaction...');

  const parentChainPublicClient = createPublicClient({
    chain: getParentChain(),
    transport: http(config.parentChainRpc),
  });

  const { chainConfig, coreContracts } = await parseDeploymentTx(parentChainPublicClient, config.deploymentTxHash);
  return { chainConfig, coreContracts };
}

export async function enterRemoteRpcMode(): Promise<boolean> {
  const chainEnv = ChainEnv.getInstance();

  logger.section('Remote RPC Mode');

  const config = validateEnvVars();
  if (!config) {
    return false;
  }

  logger.info(`Parent Chain RPC: ${config.parentChainRpc}`);
  logger.info(`Chain RPC: ${config.chainRpc}`);
  logger.info(`Deployment TX: ${config.deploymentTxHash}`);
  logger.newline();

  try {
    const { chainConfig, coreContracts } = await loadChainFromRemoteTxHash(config);

    setRemoteRpcConfig(config);
    chainEnv.setOperationMode(OperationMode.REMOTE_RPC);
    chainEnv.setNodeManager(new NodeManager(chainEnv));
    chainEnv.setRemoteRpcState(chainConfig, coreContracts, config.chainRpc);

    const parentChainPublicClient = createPublicClient({
      chain: getParentChain(),
      transport: http(config.parentChainRpc),
    });
    chainEnv.setParentChainClient(parentChainPublicClient);

    logger.success(`Connected to chain ${chainConfig.chainId}`);
    logger.info(`Rollup: ${coreContracts.rollup}`);
    logger.newline();

    return true;
  } catch (error) {
    logger.errorWithFix(
      `Failed to connect: ${error instanceof Error ? error.message : String(error)}`,
      'Verify PARENT_CHAIN_RPC, CHAIN_RPC, and CHAIN_DEPLOYMENT_TRANSACTION_HASH in your .env file are correct.',
    );
    return false;
  }
}
