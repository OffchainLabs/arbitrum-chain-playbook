import { getParentChainKey, getParentChainDisplayName, isDefaultParentChain } from '../utils/parentChain.js';
import {
  DOCKER_IMAGE,
  CONTAINER_NAME_PREFIX,
  DOCKER_DATA_DIR,
  DOCKER_USER,
  DOCKER_NODE_CONFIG_PATH,
  LOCAL_DATA_DIR,
  DEFAULT_MAIN_NODE_HTTP_PORT,
  DEFAULT_START_PORT,
  PORT_INCREMENT,
  TRANSPORT_TIMEOUT_MS,
  NODE_CONFIG_FILENAME,
  NODE_CONFIG_MALICIOUS_FILENAME,
  NODE_CONFIG_HONEST_FILENAME,
  BASE_STAKE_ETH,
  TEST_TOKENS_AMOUNT_ETH,
  CONFIRM_PERIOD_BLOCKS,
  MINIMUM_ASSERTION_PERIOD,
  L2_DEPOSIT_AMOUNT_ETH,
  MINIMUM_L2_BASE_FEE_LOWER_BOUND_GWEI,
  APP_NAME,
  DEFAULT_CHAIN_NAME,
} from '../types/constants.js';

export interface AppConfig {
  parentChainRpc: string | undefined;
  parentChainKey: string;
  parentChainDisplayName: string;
  isDefaultParentChain: boolean;
  chainRpc: string | undefined;
  deploymentTxHash: string | undefined;
  deployerPrivateKey: string | undefined;
}

export interface DockerConfig {
  image: string;
  containerPrefix: string;
  dataDir: string;
  user: string;
  nodeConfigPath: string;
  localDataDir: string;
}

export interface NetworkConfig {
  defaultMainNodeHttpPort: number;
  defaultStartPort: number;
  portIncrement: number;
  transportTimeoutMs: number;
}

export interface NodeConfigFilesConfig {
  main: string;
  malicious: string;
  honest: string;
}

export interface DeploymentConfig {
  baseStakeEth: string;
  testTokensAmountEth: string;
  confirmPeriodBlocks: bigint;
  minimumAssertionPeriod: bigint;
  l2DepositAmountEth: string;
  minimumL2BaseFeeGwei: string;
  defaultChainName: string;
}

export interface AppMetadata {
  name: string;
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

  get docker(): DockerConfig {
    return {
      image: DOCKER_IMAGE,
      containerPrefix: CONTAINER_NAME_PREFIX,
      dataDir: DOCKER_DATA_DIR,
      user: DOCKER_USER,
      nodeConfigPath: DOCKER_NODE_CONFIG_PATH,
      localDataDir: LOCAL_DATA_DIR,
    };
  }

  get network(): NetworkConfig {
    return {
      defaultMainNodeHttpPort: DEFAULT_MAIN_NODE_HTTP_PORT,
      defaultStartPort: DEFAULT_START_PORT,
      portIncrement: PORT_INCREMENT,
      transportTimeoutMs: TRANSPORT_TIMEOUT_MS,
    };
  }

  get nodeConfigFiles(): NodeConfigFilesConfig {
    return {
      main: NODE_CONFIG_FILENAME,
      malicious: NODE_CONFIG_MALICIOUS_FILENAME,
      honest: NODE_CONFIG_HONEST_FILENAME,
    };
  }

  get deployment(): DeploymentConfig {
    return {
      baseStakeEth: BASE_STAKE_ETH,
      testTokensAmountEth: TEST_TOKENS_AMOUNT_ETH,
      confirmPeriodBlocks: CONFIRM_PERIOD_BLOCKS,
      minimumAssertionPeriod: MINIMUM_ASSERTION_PERIOD,
      l2DepositAmountEth: L2_DEPOSIT_AMOUNT_ETH,
      minimumL2BaseFeeGwei: MINIMUM_L2_BASE_FEE_LOWER_BOUND_GWEI,
      defaultChainName: DEFAULT_CHAIN_NAME,
    };
  }

  get metadata(): AppMetadata {
    return {
      name: APP_NAME,
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
