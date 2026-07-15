/**
 * Shared parser for a rollup deployment transaction.
 *
 * Fetches the createRollup transaction + receipt and extracts the pieces the
 * rest of the app needs. This is the single implementation — previously the
 * same fetch/decode dance lived in init.ts, remoteRpcMode.ts, fromTxHash.ts
 * and generateNodeConfiguration.
 */

import type { PublicClient } from 'viem';
import {
  ChainConfig,
  CoreContracts,
  createRollupPrepareTransaction,
  createRollupPrepareTransactionReceipt,
} from '@arbitrum/chain-sdk';

export interface ParsedDeploymentTx {
  chainConfig: ChainConfig;
  coreContracts: CoreContracts;
  /** Raw createRollup config from the tx inputs (stakeToken, chainConfig JSON, ...). */
  rollupConfig: ReturnType<ReturnType<typeof createRollupPrepareTransaction>['getInputs']>[0]['config'];
}

export async function parseDeploymentTx(client: PublicClient, txHash: `0x${string}`): Promise<ParsedDeploymentTx> {
  // tx and receipt fetches are independent — run them concurrently.
  const [txRaw, receiptRaw] = await Promise.all([
    client.getTransaction({ hash: txHash }),
    client.getTransactionReceipt({ hash: txHash }),
  ]);
  const tx = createRollupPrepareTransaction(txRaw);
  const txReceipt = createRollupPrepareTransactionReceipt(receiptRaw);

  const rollupConfig = tx.getInputs()[0].config;
  const chainConfig: ChainConfig = JSON.parse(rollupConfig.chainConfig);
  const coreContracts: CoreContracts = txReceipt.getCoreContracts();

  return { chainConfig, coreContracts, rollupConfig };
}

/**
 * Lightweight chain-id probe: reads only the createRollup tx inputs, skipping
 * the receipt fetch + core-contracts decode that {@link parseDeploymentTx}
 * pays for. Used by startup paths that only need the chain id, so a pruned RPC
 * (no receipt) or an undecodable RollupCreated event doesn't abort them.
 */
export async function fetchChainIdFromDeploymentTx(client: PublicClient, txHash: `0x${string}`): Promise<bigint> {
  const tx = createRollupPrepareTransaction(await client.getTransaction({ hash: txHash }));
  const chainConfig: ChainConfig = JSON.parse(tx.getInputs()[0].config.chainConfig);
  return BigInt(chainConfig.chainId);
}
