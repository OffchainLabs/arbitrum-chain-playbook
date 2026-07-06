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
  const tx = createRollupPrepareTransaction(await client.getTransaction({ hash: txHash }));
  const txReceipt = createRollupPrepareTransactionReceipt(await client.getTransactionReceipt({ hash: txHash }));

  const rollupConfig = tx.getInputs()[0].config;
  const chainConfig: ChainConfig = JSON.parse(rollupConfig.chainConfig);
  const coreContracts: CoreContracts = txReceipt.getCoreContracts();

  return { chainConfig, coreContracts, rollupConfig };
}
