// Shared console logger and helpers for the timeboost playbook sub-modules.
//
// These sub-modules print with a bare emoji prefix (no color, not routed to the
// file logger), which is intentionally distinct from the global `utils/logger`
// used by the top-level orchestrator. The object below is the union of every
// method the sub-modules use; each implementation matches what they defined
// locally before being consolidated here.
import type { Address, Hash, Hex, LocalAccount, PublicClient, TransactionReceipt } from 'viem';

export const log = {
  info: (m: string) => console.log('ℹ', m),
  warn: (m: string) => console.log('⚠', m),
  success: (m: string) => console.log('✔', m),
  section: (m: string) => console.log('\n▸', m, '\n'),
  event: (m: string) => console.log('•', m),
  raw: (m: string) => console.log(m),
};

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Raw-tx helpers — the single implementation of the nonce/gasPrice/sign/send
// dance that was previously copy-pasted across bidder, deployContracts,
// experimentRecorder, expressLaneRunner and timeboostDemoRunner.
// ---------------------------------------------------------------------------

/** Minimal client surface needed for raw-tx signing/sending. */
export type RawTxClient = Pick<
  PublicClient,
  'getTransactionCount' | 'getGasPrice' | 'getChainId' | 'sendRawTransaction' | 'waitForTransactionReceipt'
>;

export interface RawTxRequest {
  /** Target address; null deploys a contract. */
  to: Address | null;
  value?: bigint;
  data?: Hex;
  gas?: bigint;
  /** Chain id override; fetched from the client when omitted. */
  chainId?: number;
}

/**
 * Build and sign an EIP-1559 tx with the account's pending nonce and a
 * 2x-gas-price fee envelope. Returns the RLP-encoded signed transaction
 * without broadcasting it (the express-lane path wraps it in an envelope).
 */
export async function signRawTx(client: RawTxClient, signer: LocalAccount<string>, req: RawTxRequest): Promise<Hex> {
  const nonce = await client.getTransactionCount({ address: signer.address, blockTag: 'pending' });
  const gasPrice = await client.getGasPrice();
  const chainId = req.chainId ?? (await client.getChainId());

  return (await signer.signTransaction({
    chainId,
    type: 'eip1559',
    to: req.to,
    value: req.value ?? 0n,
    data: req.data ?? '0x',
    gas: req.gas ?? 100_000n,
    maxFeePerGas: gasPrice * 2n,
    maxPriorityFeePerGas: gasPrice,
    nonce,
  })) as Hex;
}

/**
 * Sign and broadcast an EIP-1559 tx. Waits for the receipt unless
 * `wait: false`; throws on revert when `requireSuccess` is set.
 */
export async function signAndSendRawTx(
  client: RawTxClient,
  signer: LocalAccount<string>,
  req: RawTxRequest,
  opts: { wait?: boolean; requireSuccess?: boolean } = {},
): Promise<{ txHash: Hash; receipt?: TransactionReceipt }> {
  const signed = await signRawTx(client, signer, req);
  const txHash = await client.sendRawTransaction({ serializedTransaction: signed });

  if (opts.wait === false) return { txHash };

  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  if (opts.requireSuccess && receipt.status !== 'success') {
    throw new Error(`Tx ${txHash} reverted`);
  }
  return { txHash, receipt };
}
