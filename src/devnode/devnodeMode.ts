import { ChainConfig, NodeConfig } from '@arbitrum/chain-sdk';
import { ChainEnv, setNodeManagerClass } from '../state/chainEnv/index.js';
import { SendersEnv, SenderRole } from '../state/sendersEnv/index.js';
import { OperationMode } from '../types/index.js';
import logger from '../utils/logger.js';
import { DEVNODE_CONFIG } from './devnodeConfig.js';
import { DevnodeManager } from './devnodeManager.js';
import { DevnodeNodeManager } from './devnodeNodeManager.js';

export async function enterDevnodeMode(): Promise<void> {
  const chainEnv = ChainEnv.getInstance();
  const sendersEnv = SendersEnv.getInstance();

  setNodeManagerClass(DevnodeNodeManager);
  chainEnv.setOperationMode(OperationMode.DEVNODE);

  const chainConfig = { chainId: DEVNODE_CONFIG.chainId } as ChainConfig;
  const nodeConfig = {} as NodeConfig;
  chainEnv.setDevnodeState(chainConfig, nodeConfig);

  sendersEnv.clear();
  sendersEnv.addByPrivateKey(DEVNODE_CONFIG.privateKey, SenderRole.RegularSender);

  const devnodeManager = new DevnodeManager();
  const started = await devnodeManager.startDevnode();
  if (started) {
    logger.success('Devnode mode is ready.');
  }

  await chainEnv.nodeManager?.discoverExistingContainers();
}
