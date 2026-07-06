import { getParentChainKey, getParentChainDisplayName, isDefaultParentChain } from '../utils/parentChain.js';

export interface AppConfig {
  parentChainRpc: string | undefined;
  parentChainKey: string;
  parentChainDisplayName: string;
  isDefaultParentChain: boolean;
  chainRpc: string | undefined;
  deploymentTxHash: string | undefined;
  deployerPrivateKey: string | undefined;
}

export class ConfigService {
  private static instance: ConfigService;

  private constructor() {}

  static getInstance(): ConfigService {
    if (!ConfigService.instance) {
      ConfigService.instance = new ConfigService();
    }
    return ConfigService.instance;
  }

  get app(): AppConfig {
    return {
      parentChainRpc: process.env.PARENT_CHAIN_RPC,
      parentChainKey: getParentChainKey(),
      parentChainDisplayName: getParentChainDisplayName(),
      isDefaultParentChain: isDefaultParentChain(),
      chainRpc: process.env.CHAIN_RPC,
      deploymentTxHash: process.env.CHAIN_DEPLOYMENT_TRANSACTION_HASH,
      deployerPrivateKey: process.env.MAIN_PRIVATE_KEY,
    };
  }

  isChainModeAvailable(): boolean {
    return !!this.app.parentChainRpc;
  }

  isRemoteRpcModeAvailable(): boolean {
    return !!this.app.parentChainRpc && !!this.app.deploymentTxHash && !!this.app.chainRpc;
  }

  hasDeployerKey(): boolean {
    return !!this.app.deployerPrivateKey;
  }

  getDeploymentTxHash(): `0x${string}` | undefined {
    return this.app.deploymentTxHash as `0x${string}` | undefined;
  }
}

export const config = ConfigService.getInstance();

export default config;
