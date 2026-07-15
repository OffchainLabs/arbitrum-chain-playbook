/**
 * Shared Docker/chain validation helpers.
 *
 * Checks whether the on-chain SequencerInbox has posted batches beyond
 * genesis (batchCount > 1).
 *
 * Notes:
 * - This is intentionally conservative: if a check cannot be completed
 *   (RPC error), the function returns false (i.e., "not safe to proceed").
 */

import type { Address, PublicClient } from 'viem';
import { ISequencerInbox__factory } from '@arbitrum/sdk/dist/lib/abi/factories/ISequencerInbox__factory.js';
import logger from '../../utils/logger.js';

type ReadContractClient = Pick<PublicClient, 'readContract'>;

// Use canonical ABIs shipped with @arbitrum/sdk to avoid maintaining local ABI fragments.
const sequencerInboxAbi = ISequencerInbox__factory.abi;

/**
 * Check whether the chain has progressed beyond genesis by reading
 * SequencerInbox.batchCount.
 *
 * Rule: if batchCount > 1, treat it as non-genesis activity and fail validation.
 *
 * If the check cannot be completed, we conservatively return true (meaning validation should fail).
 */
async function hasNonGenesisSequencerBatches(params: {
  client: ReadContractClient;
  /** SequencerInbox contract address to query. */
  sequencerInboxAddress: Address;
}): Promise<boolean> {
  const { client, sequencerInboxAddress } = params;
  try {
    const batchCountRaw = await client.readContract({
      address: sequencerInboxAddress,
      abi: sequencerInboxAbi,
      functionName: 'batchCount',
    });
    const batchCount = typeof batchCountRaw === 'bigint' ? batchCountRaw : BigInt(batchCountRaw as any);
    return batchCount > 1n;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(`[validation] Failed to read batchCount from SequencerInbox ${sequencerInboxAddress}: ${msg}`);
    return true;
  }
}

/**
 * Check only the on-chain state (SequencerInbox.batchCount).
 * Returns true if the chain has not progressed beyond genesis.
 */
export async function checkOnChainIsClean(params: {
  parentClient: ReadContractClient;
  sequencerInboxAddress: Address;
}): Promise<boolean> {
  const hasBatches = await hasNonGenesisSequencerBatches({
    client: params.parentClient,
    sequencerInboxAddress: params.sequencerInboxAddress,
  });
  return !hasBatches;
}
