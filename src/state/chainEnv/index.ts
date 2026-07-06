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
import { NodeManagerLike, NodeType, OperationMode } from '../../types/index.js';
import { ChainStatus, CoreContracts, NodeConfigPaths } from './types.js';
import { loadChainDataFromDisk, nodeConfigFileExists, saveCoreContracts } from './persistence.js';
import logger from '../../utils/logger.js';

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
  private _remoteRpcUrl: string | null = null;

  // Grouped views over the private state. Plain object literals (arrow
  // functions capture `this`), so no external accessor classes reaching into
  // private fields — call-site API is unchanged (chainEnv.status.get() etc.).

  /** Status operations. */
  public readonly status = {
    /** Check if chain environment is initiated. */
    isInitiated: (): boolean => this._status !== ChainStatus.NOT_INITIATED && this._chainConfig !== null,

    /** Get current chain status (refreshes RUNNING/DEPLOYED from the node manager). */
    get: (): ChainStatus => {
      if (this._operationMode === OperationMode.DEVNODE) {
        const nodeManager = this.nodeManager;
        if (nodeManager) {
          const runningNodes = nodeManager.getRunningNodes();
          this._status = runningNodes.length > 0 ? ChainStatus.DEVNODE_RUNNING : ChainStatus.DEPLOYED;
        }
        return this._status;
      }

      if (this._status === ChainStatus.DEPLOYED || this._status === ChainStatus.RUNNING) {
        const nodeManager = this.nodeManager;
        if (nodeManager) {
          const runningNodes = nodeManager.getRunningNodes();
          this._status = runningNodes.length > 0 ? ChainStatus.RUNNING : ChainStatus.DEPLOYED;
        }
      }
      return this._status;
    },

    /** Set chain status. */
    set: (status: ChainStatus): void => {
      this._status = status;
    },
  };

  /** Node configuration operations. */
  public readonly nodeConfig = {
    /** Get node configuration. */
    get: (): NodeConfig | null => this._nodeConfig,

    /** Get all node config paths. */
    getPaths: (): NodeConfigPaths => this._nodeConfigPaths,

    /** Get node config path for specific node type. */
    getPath: (type: NodeType): string | undefined => this._nodeConfigPaths.get(type),

    /** Set node config path for specific node type. */
    setPath: (type: NodeType, path: string): void => {
      this._nodeConfigPaths.set(type, path);
    },
  };

  /** Chain configuration operations. */
  public readonly chainConfig = {
    /** Get chain configuration. */
    get: (): ChainConfig | null => this._chainConfig,

    /** Get chain ID. */
    getChainId: (): number | null => this._chainConfig?.chainId ?? null,

    /** Get core contracts. */
    getCoreContracts: (): CoreContracts | null => this._coreContracts,
  };

  /**
   * Private constructor for singleton pattern
   */
  private constructor() {}

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

    // Persist the full contract set so a later load() can restore it without
    // needing CHAIN_DEPLOYMENT_TRANSACTION_HASH (best-effort).
    saveCoreContracts(chainConfig.chainId, coreContracts);
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
   * Get the current node manager (set explicitly by each enterXxxMode).
   * Use this to access all node operations:
   *   chainEnv.nodeManager.startNode(type)
   *   chainEnv.nodeManager.stopNode(id)
   */
  get nodeManager(): NodeManagerLike | null {
    return this._nodeManager;
  }

  /**
   * Install the node manager for the current operation mode.
   * Called by mode-entry code right after setOperationMode().
   */
  setNodeManager(nodeManager: NodeManagerLike | null): void {
    this._nodeManager = nodeManager;
  }

  get operationMode(): OperationMode {
    return this._operationMode;
  }

  setOperationMode(mode: OperationMode): void {
    this._operationMode = mode;
    this._nodeManager = null;
  }
}

export default ChainEnv;
