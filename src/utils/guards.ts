/**
 * Operation guards - common precondition checks with consistent error messages.
 */

import { ChainEnv } from '../state/chainEnv/index.js';
import logger from './logger.js';

/**
 * Check if chain is initialized. Logs error if not.
 * @returns true if chain is initialized, false otherwise
 */
export function requireChainInitiated(): boolean {
  if (!ChainEnv.getInstance().status.isInitiated()) {
    logger.errorWithFix(
      'No chain detected.',
      'Deploy a chain first from Main Menu > Deploy Chain, or connect via Remote RPC mode.',
    );
    return false;
  }
  return true;
}
