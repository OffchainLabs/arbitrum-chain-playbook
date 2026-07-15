/**
 * Shared orchestration primitives for playbook demo runners.
 *
 * These consolidate boilerplate that was previously copy-pasted between the
 * malicious-mint and challenge runners. Behaviour (log lines, errorWithFix
 * text, control flow) matches what those runners inlined before.
 */

import path from 'path';
import { existsSync, readdirSync, rmSync } from 'fs';
import { formatEther, parseEther, type PrivateKeyAccount, type PublicClient } from 'viem';
import { ChainEnv } from '../state/chainEnv/index.js';
import { SendersEnv, SenderRole } from '../state/sendersEnv/index.js';
import { NodeInstance, NodeManagerLike, NodeType } from '../types/index.js';
import { LOCAL_DATA_DIR } from '../types/constants.js';
import logger from '../utils/logger.js';
import { cancellableSleep, type OperationContext } from '../utils/cancellation.js';
import { getParentChain } from '../utils/parentChain.js';
import { deployChain } from '../core/deployChain/deployChain.js';
import { depositEthToInbox } from '../core/interactChain/depositToL2.js';

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

/**
 * Return the running MAIN node, starting one if necessary.
 */
export async function ensureMainNode(nodeManager: NodeManagerLike): Promise<NodeInstance> {
  const running = nodeManager.getRunningNodes().find((n) => n.config.nodeType === NodeType.MAIN);
  if (running) return running;
  const started = await nodeManager.startNode(NodeType.MAIN);
  if (!started) throw new Error('Failed to start MAIN sequencer node.');
  // No fixed sleep here — the sole caller polls waitForChildRpcReady right
  // after, which is the real readiness gate. A blind sleep was dead time.
  return started;
}

/**
 * Poll a sequencer's HTTP RPC until it responds successfully (or timeout).
 * After `docker run -d`, the container may need 30-90s before HTTP is
 * reliably responsive — it has to process delayed messages, set up the
 * staker, etc. A fixed short sleep is insufficient on real Sepolia.
 */
export async function waitForChildRpcReady(url: string, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (res.ok) {
        const body = (await res.json()) as { result?: string; error?: { message: string } };
        if (body.result) {
          logger.info(`child RPC ready at ${url} (chainId ${parseInt(body.result, 16)})`);
          return;
        }
        lastErr = body.error?.message ?? 'unknown';
      } else {
        lastErr = `HTTP ${res.status}`;
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    await cancellableSleep(500);
  }
  throw new Error(`child RPC ${url} not ready after ${timeoutMs}ms (last: ${lastErr})`);
}

/**
 * Wipe `<LOCAL_DATA_DIR>/<chainId>/` node databases so the sequencer rebuilds
 * from genesis off the inbox. Guards against "wrong msgIdx" errors caused by
 * leftover DB state from prior crashed runs. Spares core-contracts.json,
 * which is chain metadata rather than node DB state.
 */
export function wipeLocalChainData(chainId: number | bigint): void {
  const dir = path.join(process.cwd(), LOCAL_DATA_DIR, String(chainId));
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'core-contracts.json') continue;
    rmSync(path.join(dir, entry.name), { recursive: true, force: true });
  }
  logger.info(`wiped local chain data at ${dir}`);
}

/**
 * Bridge a small amount of ETH from L1 → L2 deployer if its L2 balance is
 * below the target. Required because deployChain bridges only ~0.001 ETH,
 * too little for a demo's contract deploys + token mints + account funding.
 *
 * Everything on the child chain is gas-only and a fresh Orbit chain prices
 * gas in sub-gwei, so the target is intentionally small.
 */
export async function topUpDeployerOnL2(args: {
  chainEnv: ChainEnv;
  deployer: PrivateKeyAccount;
  childPublic: PublicClient;
  targetEth?: string;
}): Promise<void> {
  const target = parseEther(args.targetEth ?? '0.02');
  const balance = await args.childPublic.getBalance({ address: args.deployer.address });
  logger.info(`L2 deployer balance: ${formatEther(balance)} ETH`);
  if (balance >= target) {
    logger.info('Already above target; skipping deposit.');
    return;
  }

  const need = target - balance + parseEther('0.003'); // little buffer
  const coreContracts = args.chainEnv.chainConfig.getCoreContracts();
  const inbox = coreContracts?.inbox as `0x${string}` | undefined;
  if (!inbox) throw new Error('inbox address not available from ChainEnv');
  const parentClient = args.chainEnv.parentChainClient;
  if (!parentClient) throw new Error('parent chain client not available');

  logger.info(`Bridging ${formatEther(need)} ETH from L1 → L2 (deposit via inbox)...`);
  const txHash = await depositEthToInbox({
    account: args.deployer,
    parentChainPublicClient: parentClient,
    parentRpcUrl: parentClient.transport.url as string,
    inboxAddress: inbox,
    amountEth: formatEther(need),
  });
  logger.info(`L1 deposit confirmed: ${txHash}`);

  // Wait for funds to surface on L2 (typically 60-120s on Sepolia).
  const deadline = Date.now() + 4 * 60_000;
  while (Date.now() < deadline) {
    const b = await args.childPublic.getBalance({ address: args.deployer.address });
    if (b >= target) {
      logger.success(`L2 deployer balance now ${formatEther(b)} ETH`);
      return;
    }
    await cancellableSleep(4000);
  }
  throw new Error('Timed out waiting for L1 → L2 deposit to surface (4 min).');
}
