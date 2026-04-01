import { NodeConfig } from '@arbitrum/chain-sdk';
import { NodeType } from '../../../types/index.js';
import { NodeConfigPaths } from '../types.js';

// Type-only import to avoid runtime circular dependency
import type { ChainEnv } from '../index.js';

/**
 * NodeConfig accessor - manages node configuration.
 */
export class NodeConfigAccessor {
  constructor(private env: ChainEnv) {}

  /**
   * Get node configuration.
   */
  get(): NodeConfig | null {
    return this.env['_nodeConfig'];
  }

  /**
   * Get all node config paths.
   */
  getPaths(): NodeConfigPaths {
    return this.env['_nodeConfigPaths'];
  }

  /**
   * Get node config path for specific node type.
   */
  getPath(type: NodeType): string | undefined {
    return this.env['_nodeConfigPaths'].get(type);
  }

  /**
   * Set node config path for specific node type.
   */
  setPath(type: NodeType, path: string): void {
    this.env['_nodeConfigPaths'].set(type, path);
  }
}
