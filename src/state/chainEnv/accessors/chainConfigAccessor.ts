import { ChainConfig } from '@arbitrum/chain-sdk';
import { CoreContracts } from '../types.js';

// Type-only import to avoid runtime circular dependency
import type { ChainEnv } from '../index.js';

/**
 * ChainConfig accessor - manages chain configuration.
 */
export class ChainConfigAccessor {
  constructor(private env: ChainEnv) {}

  /**
   * Get chain configuration.
   */
  get(): ChainConfig | null {
    return this.env['_chainConfig'];
  }

  /**
   * Get chain ID.
   */
  getChainId(): number | null {
    return this.env['_chainConfig']?.chainId ?? null;
  }

  /**
   * Get core contracts.
   */
  getCoreContracts(): CoreContracts | null {
    return this.env['_coreContracts'];
  }
}
