import { createWalletClient, http, parseEther, type PrivateKeyAccount, type PublicClient } from 'viem';
import logger from '../../utils/logger.js';
import { ChainEnv } from '../../state/chainEnv/index.js';
import { SendersEnv, SenderRole } from '../../state/sendersEnv/index.js';
import type { Abi } from 'viem';

const inboxAbi = [
  {
    inputs: [],
    name: 'depositEth',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'payable',
    type: 'function',
  },
] as const satisfies Abi;

function getSigner(): PrivateKeyAccount | null {
  const sendersEnv = SendersEnv.getInstance();
  const senders = sendersEnv.getAllByRole(SenderRole.RegularSender);
  if (senders.length === 0) {
    logger.errorWithFix('Main account not found.', 'Set MAIN_PRIVATE_KEY in your .env file.');
    return null;
  }
  return senders[0].signer;
}

function getParentClient(chainEnv: ChainEnv): PublicClient | null {
  const parentChainPublicClient = chainEnv.parentChainClient;
  if (!parentChainPublicClient) {
    logger.errorWithFix(
      'Parent chain public client not configured.',
      'Set PARENT_CHAIN_RPC in your .env file (e.g. PARENT_CHAIN_RPC=https://sepolia-rollup.arbitrum.io/rpc).',
    );
    return null;
  }
  return parentChainPublicClient;
}

function getParentRpc(): string | null {
  const parentRpc = process.env.PARENT_CHAIN_RPC;
  if (!parentRpc) {
    logger.errorWithFix(
      'PARENT_CHAIN_RPC is not set.',
      'Add PARENT_CHAIN_RPC to your .env file (e.g. PARENT_CHAIN_RPC=https://sepolia-rollup.arbitrum.io/rpc).',
    );
    return null;
  }
  return parentRpc;
}

function getInboxAddress(chainEnv: ChainEnv): `0x${string}` | null {
  const coreContracts = chainEnv.chainConfig.getCoreContracts();
  if (!coreContracts?.inbox) {
    logger.errorWithFix(
      'Inbox contract not available.',
      'Deploy a chain first (Main Menu > Deploy Chain) or ensure chain config is loaded.',
    );
    return null;
  }
  return coreContracts.inbox as `0x${string}`;
}

/**
 * Non-interactive deposit primitive: send `depositEth` on the Inbox and wait
 * for the receipt. Shared by the interactive deposit menu and deployChain's
 * post-deploy L2 funding step. Throws on failure.
 */
export async function depositEthToInbox(params: {
  account: PrivateKeyAccount;
  parentChainPublicClient: PublicClient;
  parentRpcUrl: string;
  inboxAddress: `0x${string}`;
  amountEth: string;
}): Promise<`0x${string}`> {
  const parentWalletClient = createWalletClient({
    account: params.account,
    chain: params.parentChainPublicClient.chain,
    transport: http(params.parentRpcUrl),
  });

  const depositHash = await parentWalletClient.writeContract({
    address: params.inboxAddress,
    abi: inboxAbi,
    functionName: 'depositEth',
    value: parseEther(params.amountEth),
    chain: params.parentChainPublicClient.chain,
  });

  await params.parentChainPublicClient.waitForTransactionReceipt({ hash: depositHash });
  logger.txHash(depositHash, 'depositEth', 'success');
  return depositHash;
}

/**
 * Deposit native token from parent chain to L2 via Inbox.
 */
export async function depositNativeTokenToL2(amountEth: string): Promise<`0x${string}` | null> {
  const chainEnv = ChainEnv.getInstance();

  if (!chainEnv.status.isInitiated()) {
    logger.errorWithFix(
      'Chain is not initialized.',
      'Deploy a chain first (Main Menu > Deploy Chain) or connect via Remote RPC mode.',
    );
    return null;
  }

  const signer = getSigner();
  if (!signer) return null;

  const parentChainPublicClient = getParentClient(chainEnv);
  if (!parentChainPublicClient) return null;

  const parentRpc = getParentRpc();
  if (!parentRpc) return null;

  const inboxAddress = getInboxAddress(chainEnv);
  if (!inboxAddress) return null;

  try {
    const depositHash = await depositEthToInbox({
      account: signer,
      parentChainPublicClient,
      parentRpcUrl: parentRpc,
      inboxAddress,
      amountEth,
    });
    logger.success(`Deposited ${amountEth} ETH to L2 via Inbox`);
    return depositHash;
  } catch (error) {
    logger.errorWithFix(
      `Failed to deposit to L2: ${error instanceof Error ? error.message : String(error)}`,
      'Check that PARENT_CHAIN_RPC is reachable and the deployer account has sufficient funds.',
    );
    return null;
  }
}
