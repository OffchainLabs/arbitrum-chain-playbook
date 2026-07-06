import { ChainStatus } from '../types.js';
import { OperationMode } from '../../../types/index.js';

// Type-only import to avoid runtime circular dependency
import type { ChainEnv } from '../index.js';

/**
 * Status accessor - manages chain status.
 */
export class StatusAccessor {
  constructor(private env: ChainEnv) {}

  /**
   * Check if chain environment is initiated.
   */
  isInitiated(): boolean {
    return this.env['_status'] !== ChainStatus.NOT_INITIATED && this.env['_chainConfig'] !== null;
  }

  /**
   * Get current chain status.
   */
  get(): ChainStatus {
    const currentStatus = this.env['_status'];
    if (this.env.operationMode === OperationMode.DEVNODE) {
      const nodeManager = this.env.nodeManager;
      if (nodeManager) {
        const runningNodes = nodeManager.getRunningNodes();
        this.env['_status'] = runningNodes.length > 0 ? ChainStatus.DEVNODE_RUNNING : ChainStatus.DEPLOYED;
      }
      return this.env['_status'];
    }

    if (currentStatus === ChainStatus.DEPLOYED || currentStatus === ChainStatus.RUNNING) {
      const nodeManager = this.env.nodeManager;
      if (nodeManager) {
        const runningNodes = nodeManager.getRunningNodes();
        this.env['_status'] = runningNodes.length > 0 ? ChainStatus.RUNNING : ChainStatus.DEPLOYED;
      }
    }
    return this.env['_status'];
  }

  /**
   * Set chain status.
   */
  set(status: ChainStatus): void {
    this.env['_status'] = status;
  }
}
