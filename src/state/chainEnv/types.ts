/**
 * ChainEnv-specific type definitions
 */

import { ChainConfig, NodeConfig, CoreContracts } from '@arbitrum/chain-sdk';
import { NodeType } from '../../types/index.js';

// Re-export SDK CoreContracts for callers
export type { CoreContracts } from '@arbitrum/chain-sdk';

/**
 * Chain lifecycle status
 */
export enum ChainStatus {
  /** No chain initiated yet */
  NOT_INITATED = 'not_initated',
  /** Chain deployment in progress */
  DEPLOYING = 'deploying',
  /** Chain deployed but no nodes running */
  DEPLOYED = 'deployed',
  /** Chain deployed and at least one node running */
  RUNNING = 'running',
  /** Chain in error state */
  ERROR = 'error',
  /** Devnode is running */
  DEVNODE_RUNNING = 'devnode_running',
}

/**
 * Chain deployment result containing all necessary information
 */
export interface ChainDeploymentResult {
  chainConfig: ChainConfig;
  nodeConfig: NodeConfig;
  coreContracts: CoreContracts;
  transactionHash: `0x${string}`;
}

/**
 * Node config paths mapping for different node types
 */
export type NodeConfigPaths = Map<NodeType, string>;

/**
 * Chain data that can be persisted to disk
 */
export interface PersistedChainData {
  chainConfig: ChainConfig;
  nodeConfig: NodeConfig;
  coreContracts?: CoreContracts;
  nodeConfigPaths: Record<string, string>; // Serialized Map
}
