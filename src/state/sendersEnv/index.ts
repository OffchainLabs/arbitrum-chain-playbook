/**
 * SendersEnv - Singleton class for managing sender accounts
 *
 * Used for managing accounts that send RPC requests/transactions to nodes.
 * Accounts are organized by role and accessed via getAllByRole(role)[index].
 */

import { privateKeyToAccount } from 'viem/accounts';
import { sanitizePrivateKey } from '@arbitrum/chain-sdk/utils';
import { SenderAccount, SenderRole } from './types.js';

/**
 * SendersEnv Singleton Class
 *
 * Manages sender accounts for RPC interactions.
 */
export class SendersEnv {
  private static instance: SendersEnv | null = null;

  // Store accounts in an array
  private accounts: SenderAccount[] = [];

  /**
   * Private constructor for singleton pattern
   */
  private constructor() {}

  /**
   * Get the singleton instance
   */
  static getInstance(): SendersEnv {
    if (!SendersEnv.instance) {
      SendersEnv.instance = new SendersEnv();
    }
    return SendersEnv.instance;
  }

  /**
   * Reset the singleton instance (useful for testing)
   */
  static resetInstance(): void {
    SendersEnv.instance = null;
  }

  // ===========================================================================
  // Get Methods
  // ===========================================================================

  /**
   * Get all accounts
   */
  getAll(): SenderAccount[] {
    return [...this.accounts];
  }

  /**
   * Get all accounts for a specific role
   * Use index to access specific account: getAllByRole(SenderRole.Validator)[0]
   */
  getAllByRole(role: SenderRole): SenderAccount[] {
    return this.accounts.filter((account) => account.role === role);
  }

  // ===========================================================================
  // Add Methods
  // ===========================================================================

  /**
   * Add an account
   */
  add(account: SenderAccount): void {
    this.accounts.push(account);
  }

  /**
   * Add an account by private key
   * Creates a viem PrivateKeyAccount from the private key
   * @returns The created SenderAccount
   */
  addByPrivateKey(privateKey: string, role: SenderRole): SenderAccount {
    const sanitized = sanitizePrivateKey(privateKey);
    const signer = privateKeyToAccount(sanitized);
    const account: SenderAccount = {
      signer,
      privateKey: sanitized,
      role,
    };
    this.accounts.push(account);
    return account;
  }

  // ===========================================================================
  // Remove Methods
  // ===========================================================================

  /**
   * Remove an account by address
   * Returns true if account was removed, false if not found
   */
  removeByAddress(address: string): boolean {
    const normalizedAddress = address.toLowerCase();
    const index = this.accounts.findIndex((account) => account.signer.address.toLowerCase() === normalizedAddress);
    if (index !== -1) {
      this.accounts.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Clear all accounts with a specific role
   */
  clearByRole(role: SenderRole): void {
    this.accounts = this.accounts.filter((account) => account.role !== role);
  }

  /**
   * Clear all accounts
   */
  clear(): void {
    this.accounts = [];
  }
}

// Export singleton getter for convenience
export const getSendersEnv = (): SendersEnv => SendersEnv.getInstance();

// Re-export types
export { SenderRole, SenderAccount } from './types.js';

export default SendersEnv;
