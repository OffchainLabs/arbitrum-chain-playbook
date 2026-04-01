/**
 * Operation Guards - Utility class for common validation checks
 *
 * Centralizes repeated validation logic to reduce code duplication
 * and ensure consistent error messages across the application.
 */

import { ChainEnv } from '../state/chainEnv/index.js';
import { NodeManagerLike, NodeInstance, OperationMode } from '../types/index.js';
import logger from './logger.js';

/**
 * OperationGuard provides common validation methods for operations
 * that require specific preconditions (e.g., chain initialized, node running).
 */
export class OperationGuard {
  private get chainEnv(): ChainEnv {
    return ChainEnv.getInstance();
  }

  /**
   * Check if chain is initialized. Logs error if not.
   * @returns true if chain is initialized, false otherwise
   */
  requireChainInitiated(): boolean {
    if (!this.chainEnv.status.isInitiated()) {
      logger.errorWithFix(
        'No chain detected.',
        'Deploy a chain first from Main Menu > Deploy Chain, or connect via Remote RPC mode.',
      );
      return false;
    }
    return true;
  }

  /**
   * Check if chain is initialized in CHAIN mode specifically.
   * @returns true if in CHAIN mode and chain is initialized, false otherwise
   */
  requireChainModeInitiated(): boolean {
    if (this.chainEnv.operationMode === OperationMode.CHAIN && !this.chainEnv.status.isInitiated()) {
      logger.errorWithFix('No chain detected.', 'Deploy a chain first from Main Menu > Deploy Chain.');
      return false;
    }
    return true;
  }

  /**
   * Get NodeManager instance. Logs error if not available.
   * @returns NodeManager instance or null if not available
   */
  requireNodeManager(): NodeManagerLike | null {
    const nm = this.chainEnv.nodeManager;
    if (!nm) {
      logger.errorWithFix(
        'NodeManager not available.',
        'Deploy a chain first (Main Menu > Deploy Chain) so that the node manager is initialized.',
      );
      return null;
    }
    return nm;
  }

  /**
   * Get the main node instance. Logs error if not found.
   * @returns Main node instance or null if not found
   */
  requireMainNode(): NodeInstance | null {
    const nm = this.requireNodeManager();
    if (!nm) return null;

    const mainNode = nm.getNode('main');
    if (!mainNode) {
      logger.errorWithFix('Main node not found.', 'Start the Main Node first: Manage Nodes > Start Main Node.');
      return null;
    }
    return mainNode;
  }

  /**
   * Get the main node with its public client available.
   * Logs appropriate error messages if preconditions are not met.
   * @returns Main node instance with publicClient, or null if not available
   */
  requireMainNodeWithClient(): NodeInstance | null {
    const mainNode = this.requireMainNode();
    if (!mainNode) return null;

    if (!mainNode.publicClient) {
      logger.errorWithFix(
        'Main node RPC client not available.',
        'Start the Main Node first: Manage Nodes > Start Main Node.',
      );
      return null;
    }
    return mainNode;
  }

  /**
   * Combined check: chain initialized + node manager available.
   * @returns NodeManager instance or null if preconditions not met
   */
  requireChainAndNodeManager(): NodeManagerLike | null {
    if (!this.requireChainInitiated()) return null;
    return this.requireNodeManager();
  }
}

// Singleton instance for convenience
export const guard = new OperationGuard();

export default guard;
