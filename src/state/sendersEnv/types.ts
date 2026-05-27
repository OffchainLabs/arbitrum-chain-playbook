/**
 * Types for SendersEnv - manages sender accounts for RPC requests
 */

import type { PrivateKeyAccount } from 'viem';

/**
 * Sender role enum - unified role for all account types
 */
export enum SenderRole {
  Validator = 'validator',
  BatchPoster = 'batchPoster',
  RegularSender = 'regularSender',
}

/**
 * A sender account used for sending RPC requests/transactions
 */
export interface SenderAccount {
  /** Viem account with signing capabilities */
  signer: PrivateKeyAccount;
  /** Private key (stored for config generation) */
  privateKey: `0x${string}`; // View PrivateKeyAccount does not have a private key property, so we store it here
  /** Role of this account */
  role: SenderRole;
}
