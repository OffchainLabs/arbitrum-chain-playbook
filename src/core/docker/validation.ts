/**
 * Shared Docker/chain validation helpers.
 *
 * This module provides a single shared validation function that checks:
 * 1) Whether the on-chain SequencerInbox has posted batches beyond genesis (batchCount > 1).
 * 2) Whether the local database directory for the target chain contains leftover (unclean) data.
 *
 * If either condition is true, the validation fails and returns false.
 *
 * Notes:
 * - This is intentionally conservative: if a check cannot be completed (RPC/filesystem error),
 *   the function returns false (i.e., "not safe to proceed").
 * - Comments are in English by requirement.
 */

import fs from 'fs';
import path from 'path';
import type { Address, PublicClient } from 'viem';
import { ISequencerInbox__factory } from '@arbitrum/sdk/dist/lib/abi/factories/ISequencerInbox__factory.js';
import { LOCAL_DATA_DIR } from '../../types/constants.js';
import logger from '../../utils/logger.js';

type ReadContractClient = Pick<PublicClient, 'readContract'>;

// Use canonical ABIs shipped with @arbitrum/sdk to avoid maintaining local ABI fragments.
const sequencerInboxAbi = ISequencerInbox__factory.abi;

const LOCAL_DB_IGNORE_FILENAMES = new Set<string>(['.DS_Store']);

const isErrnoWithCode = (err: unknown): err is NodeJS.ErrnoException =>
  typeof err === 'object' && err !== null && 'code' in err;

/**
 * Returns true if the directory contains any non-ignored file (recursively).
 * Empty directories (including nested empty directories) are considered clean.
 */
async function directoryContainsAnyNonIgnoredFile(dir: string): Promise<boolean> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const name = entry.name;
      if (LOCAL_DB_IGNORE_FILENAMES.has(name)) continue;

      const fullPath = path.join(dir, name);

      if (entry.isFile() || entry.isSymbolicLink()) {
        return true;
      }

      if (entry.isDirectory()) {
        const nestedHasFile = await directoryContainsAnyNonIgnoredFile(fullPath);
        if (nestedHasFile) return true;
        continue;
      }

      // Other types (FIFO, socket, etc.) are treated as unclean.
      return true;
    }

    return false;
  } catch (err) {
    // Missing directory is clean.
    if (isErrnoWithCode(err) && err.code === 'ENOENT') return false;

    // Any other error means we can't confidently validate; treat as unclean.
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(`[validation] Failed to read directory "${dir}": ${msg}`);
    return true;
  }
}

/**
 * Condition (2): check whether local DB data for the target chain is unclean.
 *
 * The data root is: <cwd>/.arbitrum/<chainId>
 */
async function hasUncleanLocalDbData(chainId: number | bigint, cwd: string): Promise<boolean> {
  const chainDir = path.join(cwd, LOCAL_DATA_DIR, chainId.toString());
  return directoryContainsAnyNonIgnoredFile(chainDir);
}

/**
 * Condition (1): check whether the chain has progressed beyond genesis by
 * reading SequencerInbox.batchCount.
 *
 * Rule (requested): if batchCount > 1, treat it as non-genesis activity and fail validation.
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

/**
 * Shared validation entry point.
 *
 * Returns true only if:
 * - SequencerInbox.batchCount <= 1, AND
 * - local DB data for the target chain is clean.
 *
 * If either condition is true, returns false.
 */
export async function validateRollupAndLocalDbClean(params: {
  parentClient: ReadContractClient;
  /** SequencerInbox contract address to query. */
  sequencerInboxAddress: Address;
  chainId: number | bigint;
  /** Base directory to check local data under. Defaults to process.cwd(). */
  cwd?: string;
}): Promise<boolean> {
  const cwd = params.cwd ?? process.cwd();

  const [hasBatchesBeyondGenesis, uncleanLocalDb] = await Promise.all([
    hasNonGenesisSequencerBatches({
      client: params.parentClient,
      sequencerInboxAddress: params.sequencerInboxAddress,
    }),
    hasUncleanLocalDbData(params.chainId, cwd),
  ]);

  // If either condition is true, validation fails.
  return !(hasBatchesBeyondGenesis || uncleanLocalDb);
}
