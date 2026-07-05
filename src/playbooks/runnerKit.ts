/**
 * Shared orchestration primitives for playbook demo runners.
 *
 * These consolidate boilerplate that was previously copy-pasted between the
 * malicious-mint and challenge runners. Behaviour (log lines, errorWithFix
 * text, control flow) matches what those runners inlined before.
 */

import { ChainEnv } from '../state/chainEnv/index.js';
import { NodeManagerLike } from '../types/index.js';
import logger from '../utils/logger.js';
import { type OperationContext } from '../utils/cancellation.js';
import { getParentChain } from '../utils/parentChain.js';
import { deployChain } from '../core/deployChain/deployChain.js';

/**
 * Stop every running node, if any. No-op when the node manager is absent or
 * nothing is running.
 */
export async function stopRunningNodes(nodeManager: NodeManagerLike | null): Promise<void> {
  if (!nodeManager) return;
  const runningNodes = nodeManager.getRunningNodes();
  if (runningNodes.length > 0) {
    logger.info(`Stopping ${runningNodes.length} running node(s)...`);
    await nodeManager.stopAllNodes();
    logger.success('All nodes stopped.');
  }
}

/**
 * Stop any running nodes, deploy a fresh chain with the given
 * confirmPeriodBlocks, then reload chain env from disk.
 *
 * Returns false (after logging an actionable errorWithFix) if either the
 * deployment or the post-deploy reload fails; the caller is responsible for
 * marking its step tracker failed and returning its own result shape.
 */
export async function redeployFreshChain(confirmPeriodBlocks: bigint, ctx?: OperationContext): Promise<boolean> {
  const chainEnv = ChainEnv.getInstance();
  await stopRunningNodes(chainEnv.nodeManager);

  logger.info(`Deploying chain with confirmPeriodBlocks=${confirmPeriodBlocks}...`);
  const deploySuccess = await deployChain(getParentChain(), ctx, { confirmPeriodBlocks, skipPrompts: true });
  if (!deploySuccess) {
    logger.errorWithFix('Chain deployment failed.', 'Check PARENT_CHAIN_RPC and MAIN_PRIVATE_KEY in .env file.');
    return false;
  }

  if (!chainEnv.status.isInitiated() && !chainEnv.load()) {
    logger.errorWithFix(
      'Failed to load chain after deployment.',
      'Check that node-config.json was created successfully.',
    );
    return false;
  }

  logger.success('Chain deployed successfully.');
  return true;
}
