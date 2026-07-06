/**
 * ChainEnv - Singleton class for managing chain lifecycle
 *
 * API organized into logical accessors:
 * - chainEnv.status      - Status operations
 * - chainEnv.nodeConfig  - Node configuration operations
 * - chainEnv.chainConfig - Chain configuration operations
 * - chainEnv.nodeManager - Node management (via getNodeManager())
 */

import { ChainConfig, NodeConfig } from '@arbitrum/chain-sdk';
import { PublicClient } from 'viem';
import { NodeManagerLike, OperationMode } from '../../types/index.js';
import { ChainStatus, CoreContracts, NodeConfigPaths } from './types.js';
import { loadChainDataFromDisk, nodeConfigFileExists } from './persistence.js';
import logger from '../../utils/logger.js';
import { StatusAccessor } from './accessors/statusAccessor.js';
import { NodeConfigAccessor } from './accessors/nodeConfigAccessor.js';
import { ChainConfigAccessor } from './accessors/chainConfigAccessor.js';

// Forward declaration to avoid circular dependency
let NodeManagerClass: (new (chainEnv: ChainEnv) => NodeManagerLike) | null = null;

export function setNodeManagerClass(cls: new (chainEnv: ChainEnv) => NodeManagerLike): void {
  NodeManagerClass = cls;
}

// =============================================================================
// ChainEnv Singleton Class
// =============================================================================

/**
 * ChainEnv Singleton Class
 *
 * Manages the chain lifecycle including:
 * - Chain deployment state
 * - Configuration persistence
 * - Status tracking
 *
 * Access organized APIs via:
 * - chainEnv.status      - Status operations
 * - chainEnv.nodeConfig  - Node configuration operations
 * - chainEnv.chainConfig - Chain configuration operations
 * - chainEnv.nodeManager - Node management
 */
export class ChainEnv {
  private static instance: ChainEnv | null = null;

  // Internal state (accessed by accessor classes)
  private _chainConfig: ChainConfig | null = null;
  private _nodeConfig: NodeConfig | null = null;
  private _coreContracts: CoreContracts | null = null;
  private _nodeConfigPaths: NodeConfigPaths = new Map();
  private _status: ChainStatus = ChainStatus.NOT_INITIATED;
  private _nodeManager: NodeManagerLike | null = null;
  private _parentChainPublicClient: PublicClient | null = null;
  private _operationMode: OperationMode = OperationMode.NONE;
  private _chainModeAvailable: boolean = true;
  private _remoteRpcModeAvailable: boolean = false;
  private _remoteRpcUrl: string | null = null;

  // Accessors
  public readonly status: StatusAccessor;
  public readonly nodeConfig: NodeConfigAccessor;
  public readonly chainConfig: ChainConfigAccessor;

  /**
   * Private constructor for singleton pattern
   */
  private constructor() {
    this.status = new StatusAccessor(this);
    this.nodeConfig = new NodeConfigAccessor(this);
    this.chainConfig = new ChainConfigAccessor(this);
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): ChainEnv {
    if (!ChainEnv.instance) {
      ChainEnv.instance = new ChainEnv();
    }
    return ChainEnv.instance;
  }

  /**
   * Reset the singleton instance (useful for testing)
   */
  static resetInstance(): void {
    if (ChainEnv.instance) {
      ChainEnv.instance._nodeManager = null;
    }
    ChainEnv.instance = null;
  }

  // ===========================================================================
  // Lifecycle Methods (kept on root)
  // ===========================================================================

  /**
   * Load chain configuration from disk
   * Returns true if successful
   */
  load(): boolean {
    if (!nodeConfigFileExists()) {
      return false;
    }

    try {
      const data = loadChainDataFromDisk();
      if (data) {
        this._chainConfig = data.chainConfig;
        this._nodeConfig = data.nodeConfig;
        this._coreContracts = data.coreContracts || null;
        this._nodeConfigPaths = data.nodeConfigPaths;
        this._status = ChainStatus.DEPLOYED;
        return true;
      }
    } catch (error) {
      logger.warn(`Failed to load chain data: ${error instanceof Error ? error.message : String(error)}`);
    }
    return false;
  }

  /**
   * Set chain data after deployment or reconstruction from tx hash
   */
  setDeploymentResult(
    chainConfig: ChainConfig,
    nodeConfig: NodeConfig,
    coreContracts: CoreContracts,
    nodeConfigPaths: NodeConfigPaths,
  ): void {
    this._chainConfig = chainConfig;
    this._nodeConfig = nodeConfig;
    this._coreContracts = coreContracts;
    this._nodeConfigPaths = nodeConfigPaths;
    this._status = ChainStatus.DEPLOYED;
  }

  /**
   * Reset chain state (clear all data)
   */
  reset(): void {
    this._chainConfig = null;
    this._nodeConfig = null;
    this._coreContracts = null;
    this._nodeConfigPaths = new Map();
    this._status = ChainStatus.NOT_INITIATED;
    this._operationMode = OperationMode.NONE;
    this._remoteRpcUrl = null;

    // Stop all nodes if running
    if (this._nodeManager) {
      this._nodeManager.stopAllNodes();
    }
  }

  setDevnodeState(chainConfig: ChainConfig, nodeConfig: NodeConfig): void {
    this._chainConfig = chainConfig;
    this._nodeConfig = nodeConfig;
    this._coreContracts = null;
    this._nodeConfigPaths = new Map();
    this._status = ChainStatus.DEPLOYED;
  }

  /**
   * Set chain state for remote RPC mode
   * Used when connecting to a deployed chain via RPC endpoints
   */
  setRemoteRpcState(chainConfig: ChainConfig, coreContracts: CoreContracts, rpcUrl: string): void {
    this._chainConfig = chainConfig;
    this._nodeConfig = null;
    this._coreContracts = coreContracts;
    this._nodeConfigPaths = new Map();
    this._status = ChainStatus.DEPLOYED;
    this._remoteRpcUrl = rpcUrl;
  }

  /**
   * Get the remote RPC URL (only available in REMOTE_RPC mode)
   */
  get remoteRpcUrl(): string | null {
    return this._remoteRpcUrl;
  }

  // ===========================================================================
  // Parent Chain Client
  // ===========================================================================

  /**
   * Get the parent chain public client
   */
  get parentChainClient(): PublicClient | null {
    return this._parentChainPublicClient;
  }

  /**
   * Set the parent chain public client
   */
  setParentChainClient(client: PublicClient): void {
    this._parentChainPublicClient = client;
  }

  // ===========================================================================
  // Node Manager Access
  // ===========================================================================

  /**
   * Get NodeManager instance (lazy initialization)
   * Use this to access all node operations:
   *   chainEnv.nodeManager.startNode(type)
   *   chainEnv.nodeManager.stopNode(id)
   */
  get nodeManager(): NodeManagerLike | null {
    if (!this._nodeManager && NodeManagerClass) {
      this._nodeManager = new NodeManagerClass(this);
    }
    return this._nodeManager;
  }

  get operationMode(): OperationMode {
    return this._operationMode;
  }

  setOperationMode(mode: OperationMode): void {
    this._operationMode = mode;
    this._nodeManager = null;
  }

  setChainModeAvailable(available: boolean): void {
    this._chainModeAvailable = available;
  }

  isChainModeAvailable(): boolean {
    return this._chainModeAvailable;
  }

  setRemoteRpcModeAvailable(available: boolean): void {
    this._remoteRpcModeAvailable = available;
  }

  isRemoteRpcModeAvailable(): boolean {
    return this._remoteRpcModeAvailable;
  }
}

export default ChainEnv;
