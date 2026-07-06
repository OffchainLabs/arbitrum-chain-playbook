/**
 * Shared orchestration primitives for playbook demo runners.
 *
 * These consolidate boilerplate that was previously copy-pasted between the
 * malicious-mint and challenge runners. Behaviour (log lines, errorWithFix
 * text, control flow) matches what those runners inlined before.
 */

import { ChainEnv } from '../state/chainEnv/index.js';
import { SendersEnv, SenderRole } from '../state/sendersEnv/index.js';
import { NodeManagerLike } from '../types/index.js';
import logger from '../utils/logger.js';
import { type OperationContext } from '../utils/cancellation.js';
import { getParentChain } from '../utils/parentChain.js';
import { deployChain } from '../core/deployChain/deployChain.js';

/**
 * Get the main sender's (RegularSender) private key, or throw with an
 * actionable message when none is registered.
 */
export function getMainSenderPrivateKey(): `0x${string}` {
  const senders = SendersEnv.getInstance().getAllByRole(SenderRole.RegularSender);
  if (senders.length === 0) {
    throw new Error('No RegularSender account found. Please add a sender account first.');
  }
  return senders[0].privateKey;
}

/**
 * Get the parent chain RPC URL from the environment. Runners must not fall
 * back to a hardcoded public network — failing fast beats silently talking
 * to the wrong chain.
 */
export function getParentChainRpcUrl(): string {
  const url = process.env.PARENT_CHAIN_RPC;
  if (!url) {
    throw new Error('PARENT_CHAIN_RPC is not set. Add it to your .env file.');
  }
  return url;
}

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
