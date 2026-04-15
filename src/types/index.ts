/**
 * Type definitions for Arbitrum Chain Playbook
 */

import { ChainConfig, NodeConfig } from '@arbitrum/chain-sdk';
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

// Chain environment data (node config + chain config)
// Note: This is a data transfer object, not the ChainEnv singleton class
export interface ChainEnvData {
  nodeConfig: NodeConfig;
  nodeConfigPaths: Map<NodeType, string>; // Different NodeType maps to different config file paths
  chainConfig: ChainConfig;
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

// Global application state
export interface AppState {
  chain: ChainConfig | null;
  nodes: Map<string, NodeInstance>;
}

export interface NodeManagerLike {
  // Node querying
  getRunningNodes(): NodeInstance[];
  getNode(nodeId: string): NodeInstance | undefined;

  // Node lifecycle
  startNode(type: NodeType, options?: { dockerImage?: string }): Promise<NodeInstance | null>;
  stopNode(nodeId: string): Promise<boolean>;
  stopAllNodes(): Promise<void>;
  discoverExistingContainers(): Promise<void>;
  displayStatus(): void;

  // Health monitoring
  checkNodeHealth?(nodeId: string): Promise<boolean>;
  getNodeUptime?(nodeId: string): Promise<string>;
  isMonitoringActive?(): boolean;
  startHealthMonitoring?(): Promise<void>;
  stopHealthMonitoring?(): void;
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
  START_HONEST = 'start_honest',
  START_MALICIOUS = 'start_malicious',
  START_BOTH = 'start_both',
  STOP_NODE = 'stop_node',
  STOP_ALL = 'stop_all',
  BACK = 'back',
}

// Interface call action types
export enum InterfaceAction {
  ACT_HONEST = 'act_honest',
  ACT_MALICIOUS = 'act_malicious',
  GET_BLOCK_HEIGHT = 'get_block_height',
  GET_VALIDATOR_SET = 'get_validator_set',
  SUBMIT_TRANSACTION = 'submit_transaction',
  BACK = 'back',
}
