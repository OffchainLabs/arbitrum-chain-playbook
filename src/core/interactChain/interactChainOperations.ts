/**
 * Interact Chain Operations
 * Provides interactive menu for chain interaction operations.
 * Supports both Chain Mode and Remote RPC Mode.
 */

import inquirer from 'inquirer';
import logger from '../../utils/logger.js';
import { ChainEnv } from '../../state/chainEnv/index.js';
import { OperationMode } from '../../types/index.js';
import { depositNativeTokenToL2 } from './depositToL2.js';
import { breadcrumb } from '../../utils/breadcrumb.js';
import { waitForEnter } from '../../utils/inquirerUtils.js';

/**
 * Interact Chain Operations
 * Provides interactive menu for chain interaction operations.
 */
export class InteractChainOperations {
  /**
   * Show the interact chain menu.
   */
  async showMenu(): Promise<void> {
    const chainEnv = ChainEnv.getInstance();
    if (!chainEnv.status.isInitiated()) {
      logger.errorWithFix(
        'No chain detected.',
        'Deploy a chain first from Main Menu > Deploy Chain, or connect via Remote RPC mode.',
      );
      logger.newline();
      return;
    }

    breadcrumb.push('Interact with Chain');
    while (true) {
      breadcrumb.render();
      const { action } = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: 'Select an operation:',
          choices: this.getMenuChoices(),
        },
      ]);

      if (action === 'back') {
        breadcrumb.pop();
        return;
      }

      switch (action) {
        case 'deposit-to-l2':
          await this.handleDepositToL2();
          break;
      }

      await waitForEnter('Press Enter to return to the menu...');
      logger.newline();
    }
  }

  /**
   * Get menu choices based on current operation mode
   */
  private getMenuChoices() {
    const chainEnv = ChainEnv.getInstance();
    const mode = chainEnv.operationMode;

    // Both Chain Mode and Remote RPC Mode support deposit
    const choices = [{ name: 'Deposit Native Token to L2', value: 'deposit-to-l2' }];

    // Add mode-specific options here if needed in the future

    choices.push(new inquirer.Separator() as never);
    choices.push({ name: '← Back to Main Menu', value: 'back' } as never);

    return choices;
  }

  /**
   * Handle deposit to L2 operation
   */
  private async handleDepositToL2(): Promise<void> {
    const chainEnv = ChainEnv.getInstance();
    const mode = chainEnv.operationMode;

    logger.info(`Mode: ${mode === OperationMode.REMOTE_RPC ? 'Remote RPC' : 'Chain'}`);

    const { amount } = await inquirer.prompt([
      {
        type: 'input',
        name: 'amount',
        message: 'Enter amount of ETH to deposit:',
        default: '0.001',
        validate: (input: string) => {
          const num = parseFloat(input);
          if (isNaN(num) || num <= 0) {
            return 'Please enter a valid positive number';
          }
          return true;
        },
      },
    ]);

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Deposit ${amount} ETH to L2?`,
        default: true,
      },
    ]);

    if (!confirm) {
      logger.info('Deposit cancelled.');
      return;
    }

    const txHash = await depositNativeTokenToL2(amount);
    if (txHash) {
      logger.newline();
      logger.raw(`Transaction hash: ${txHash}`);
    }
  }
}

export const interactChainOperations = new InteractChainOperations();
export default interactChainOperations;
