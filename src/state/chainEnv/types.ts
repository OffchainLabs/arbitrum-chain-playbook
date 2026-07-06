/**
 * ChainEnv-specific type definitions
 */

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
 * Node config paths mapping for different node types
 */
export type NodeConfigPaths = Map<NodeType, string>;
