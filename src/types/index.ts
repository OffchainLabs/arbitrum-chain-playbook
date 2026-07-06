/**
 * Type definitions for Arbitrum Chain Playbook
 */

import { ChainConfig, CoreContracts, NodeConfig } from '@arbitrum/chain-sdk';
import { PublicClient } from 'viem';

// Node types
export enum NodeType {
  MAIN = 'main',
  HONEST = 'honest',
  MALICIOUS = 'malicious',
}

// Node status
export enum NodeStatus {
  STOPPED = 'stopped',
  STARTING = 'starting',
  RUNNING = 'running',
  ERROR = 'error',
}

export enum OperationMode {
  NONE = 'none',
  CHAIN = 'chain',
  DEVNODE = 'devnode',
  REMOTE_RPC = 'remote_rpc',
}

// Bundle of chain state produced by deployment / tx-hash reconstruction and
// persisted to / loaded from disk. This is THE chain-data DTO — do not add
// parallel shapes for the same tuple.
// Note: This is a data transfer object, not the ChainEnv singleton class.
export interface ChainData {
  chainConfig: ChainConfig;
  nodeConfig: NodeConfig;
  nodeConfigPaths: Map<NodeType, string>; // Different NodeType maps to different config file paths
  coreContracts?: CoreContracts;
}

// Node instance (runtime state)
export interface NodeInstance {
  config: SingleNodeConfig;
  status: NodeStatus;
  containerId?: string;
  containerName?: string; // Store actual container name for proper stopping
  startedAt?: Date;
  blockHeight?: number;
  lastHealthStatus?: boolean;
  publicClient?: PublicClient; // viem PublicClient for RPC calls
}

export interface SingleNodeConfig {
  id: string;
  nodeType: NodeType;
  httpPort: number;
  wsPort: number;
  forwardingTargetPort?: number; // Main node's HTTP port for forwarding transactions (only for non-MAIN nodes)
}

export interface NodeManagerLike {
  // Node querying
  getRunningNodes(): NodeInstance[];
  getNode(nodeId: string): NodeInstance | undefined;
  getNodes(): Map<string, NodeInstance>;

  // Node lifecycle
  startNode(
    type: NodeType,
    options?: { dockerImage?: string; extraDockerArgs?: string[] },
  ): Promise<NodeInstance | null>;
  stopNode(nodeId: string): Promise<boolean>;
  stopAllNodes(): Promise<void>;
  discoverExistingContainers(): Promise<void>;
  displayStatus(): void;

  // Health monitoring
  checkNodeHealth(nodeId: string): Promise<boolean>;
  getNodeUptime(nodeId: string): Promise<string>;
  isMonitoringActive(): boolean;
  startHealthMonitoring(): Promise<void>;
  stopHealthMonitoring(): void;
}

// Menu action types
export enum MenuAction {
  DEPLOY_CHAIN = 'deploy_chain',
  MANAGE_NODES = 'manage_nodes',

  INTERACT_CHAIN = 'interact_chain',
  VIEW_STATUS = 'view_status',
  NODECONFIG_OPERATIONS = 'nodeconfig_operations',
  PLAYBOOK_LIST = 'playbook_list',
  EXIT = 'exit',
}

// Node management action types
export enum NodeAction {
  START_MAIN = 'start_main',
  STOP_NODE = 'stop_node',
  STOP_ALL = 'stop_all',
  BACK = 'back',
}
