/**
 * Configuration types and state for Remote RPC Mode
 *
 * Remote RPC mode allows connecting to a deployed chain via RPC endpoints
 * without running local nodes. Users provide:
 * - Deployment transaction hash
 * - Parent chain RPC URL
 * - Chain RPC URL
 */

/**
 * Configuration required for remote RPC mode
 */
export interface RemoteRpcConfig {
  /** Deployment transaction hash on parent chain */
  deploymentTxHash: `0x${string}`;
  /** Parent chain RPC URL */
  parentChainRpc: string;
  /** Chain's own RPC URL */
  chainRpc: string;
}

/**
 * Current remote RPC configuration (set when entering remote RPC mode)
 */
let currentRemoteRpcConfig: RemoteRpcConfig | null = null;

/**
 * Get the current remote RPC configuration
 */
export function getRemoteRpcConfig(): RemoteRpcConfig | null {
  return currentRemoteRpcConfig;
}

/**
 * Set the remote RPC configuration
 */
export function setRemoteRpcConfig(config: RemoteRpcConfig): void {
  currentRemoteRpcConfig = config;
}

/**
 * Clear the remote RPC configuration
 */
export function clearRemoteRpcConfig(): void {
  currentRemoteRpcConfig = null;
}
