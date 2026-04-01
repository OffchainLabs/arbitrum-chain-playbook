import inquirer from 'inquirer';
import logger from '../../utils/logger.js';
import { ChainEnv } from '../../state/chainEnv/index.js';
import { SendersEnv, SenderRole } from '../../state/sendersEnv/index.js';
import { parseGwei, type PublicClient, type PrivateKeyAccount } from 'viem';
import { arbOwnerPublicActions } from '@arbitrum/chain-sdk';
import { MINIMUM_L2_BASE_FEE_LOWER_BOUND_GWEI } from '../../types/constants.js';
import { guard } from '../../utils/guards.js';
import { breadcrumb } from '../../utils/breadcrumb.js';
import { waitForEnter } from '../../utils/inquirerUtils.js';
import chalk from 'chalk';

// ArbOwnerPublic precompile address
const ARB_OWNER_PUBLIC_ADDRESS = '0x000000000000000000000000000000000000006b' as const;

// ABI fragment for ArbOwnerPublic.isChainOwner
const arbOwnerPublicAbi = [
  {
    inputs: [{ name: 'addr', type: 'address' }],
    name: 'isChainOwner',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// TPS optimization configuration values
const TPS_CONFIG = {
  SPEED_LIMIT: 150_000_000n,
  L2_GAS_BACKLOG_TOLERANCE: 100_000n,
  L2_GAS_PRICING_INERTIA: 100_000n,
  L1_PRICE_PER_UNIT: 0n,
} as const;

/**
 * Manage Chain Operations
 * Provides interactive menu for chain management operations.
 */
export class ManageChainOperations {
  /**
   * Show the manage chain menu.
   * Validates that the current signer is a chain owner before displaying the menu.
   */
  async showMenu(): Promise<void> {
    // Validate chain owner before showing the menu
    const envCheck = await this.validateChainOwner();
    if (!envCheck) {
      return;
    }

    breadcrumb.push('Manage Chain');
    while (true) {
      breadcrumb.render();
      const { action } = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: 'Select an operation:',
          choices: [
            {
              name: `Set Config for TPS ${chalk.dim('— Apply all TPS optimizations at once')}`,
              value: 'set-config-for-tps',
            },
            new inquirer.Separator('========== Individual Settings =========='),
            { name: 'Set Speed Limit (150,000,000)', value: 'set-speed-limit' },
            { name: 'Set L2 Gas Backlog Tolerance (100,000)', value: 'set-l2-gas-backlog-tolerance' },
            { name: 'Set L2 Gas Pricing Inertia (100,000)', value: 'set-l2-gas-pricing-inertia' },
            { name: 'Set L1 Price Per Unit (0)', value: 'set-l1-price-per-unit' },
            { name: 'Set Minimum L2 Base Fee (0.0001 gwei)', value: 'set-minimum-l2-base-fee' },
            new inquirer.Separator(),
            { name: '← Back to Main Menu', value: 'back' },
          ],
        },
      ]);

      if (action === 'back') {
        breadcrumb.pop();
        return;
      }

      switch (action) {
        case 'set-config-for-tps':
          await this.setConfigForTPS();
          break;
        case 'set-speed-limit':
          await this.setSpeedLimit();
          break;
        case 'set-l2-gas-backlog-tolerance':
          await this.setL2GasBacklogTolerance();
          break;
        case 'set-l2-gas-pricing-inertia':
          await this.setL2GasPricingInertia();
          break;
        case 'set-l1-price-per-unit':
          await this.setL1PricePerUnit();
          break;
        case 'set-minimum-l2-base-fee':
          await this.setMinimumL2BaseFeeToLowerBound();
          break;
      }

      await waitForEnter('Press Enter to return to the menu...');
      logger.newline();
    }
  }

  /**
   * Validate that the current signer is a chain owner.
   * Returns true if validation passes, false otherwise.
   */
  private async validateChainOwner(): Promise<boolean> {
    const env = await this.getChainEnvContext();
    if (!env) return false;

    const { orbitChainPublicClient, signer } = env;

    try {
      const isOwner = await orbitChainPublicClient.readContract({
        address: ARB_OWNER_PUBLIC_ADDRESS,
        abi: arbOwnerPublicAbi,
        functionName: 'isChainOwner',
        args: [signer.address],
      });

      if (!isOwner) {
        logger.errorWithFix(
          'Current account is not a Chain Owner.',
          'Set MAIN_PRIVATE_KEY to a chain-owner account. The deployer address is a chain owner by default.',
        );
        return false;
      }

      return true;
    } catch (error) {
      logger.errorWithFix(
        `Failed to check chain owner status: ${error instanceof Error ? error.message : String(error)}`,
        'Ensure the main node is running and reachable. Start it via Manage Nodes > Start Main Node.',
      );
      return false;
    }
  }

  /**
   * Get the common chain environment context needed for chain operations.
   * Returns null if any required component is missing.
   */
  private async getChainEnvContext(): Promise<{
    orbitChainPublicClient: ReturnType<typeof arbOwnerPublicActions> & PublicClient;
    signer: PrivateKeyAccount;
    orbitRpcUrl: string;
  } | null> {
    // Use guard for common validation checks
    const mainNode = guard.requireMainNodeWithClient();
    if (!mainNode) {
      return null;
    }

    const orbitRpcUrl = `http://localhost:${mainNode.config.httpPort}`;

    const sendersEnv = SendersEnv.getInstance();
    const deployers = sendersEnv.getAllByRole(SenderRole.RegularSender);
    if (deployers.length === 0) {
      logger.errorWithFix('Main account not found.', 'Set MAIN_PRIVATE_KEY in your .env file.');
      return null;
    }
    const signer = deployers[0].signer;

    // publicClient is guaranteed to exist after requireMainNodeWithClient check
    const orbitChainPublicClient = mainNode.publicClient!.extend(arbOwnerPublicActions);

    try {
      await orbitChainPublicClient.getBlockNumber();
    } catch (_) {
      logger.errorWithFix(
        `Orbit node RPC is not reachable at ${orbitRpcUrl}.`,
        'Start the Main Node first: Manage Nodes > Start Main Node.',
      );
      return null;
    }

    return { orbitChainPublicClient, signer, orbitRpcUrl };
  }

  /**
   * Set the minimum L2 base fee to 0.0001 gwei via ArbOwner.
   * Uses arbOwnerPrepareTransactionRequest.
   */
  private async setMinimumL2BaseFeeToLowerBound(): Promise<void> {
    const env = await this.getChainEnvContext();
    if (!env) return;

    const { orbitChainPublicClient, signer, orbitRpcUrl } = env;
    const priceInWei = parseGwei(MINIMUM_L2_BASE_FEE_LOWER_BOUND_GWEI);

    logger.info(`Preparing transaction: setMinimumL2BaseFee(${priceInWei} wei) on ${orbitRpcUrl}`);
    const txRequest = await orbitChainPublicClient.arbOwnerPrepareTransactionRequest({
      functionName: 'setMinimumL2BaseFee',
      args: [priceInWei],
      upgradeExecutor: false,
      account: signer.address,
    });

    const txHash = await orbitChainPublicClient.sendRawTransaction({
      serializedTransaction: await signer.signTransaction(txRequest),
    });

    const receipt = await orbitChainPublicClient.waitForTransactionReceipt({ hash: txHash });
    logger.txHash(txHash, 'setMinimumL2BaseFee', receipt.status);
    logger.success(`Minimum L2 base fee set (tx status: ${receipt.status})`);
  }

  // =============================================================================
  // TPS Optimization Configuration Methods
  // =============================================================================

  /**
   * Set all TPS optimization configurations at once.
   * Calls setSpeedLimit, setL2GasBacklogTolerance, setL2GasPricingInertia,
   * setL1PricePerUnit, and setMinimumL2BaseFeeToLowerBound.
   */
  private async setConfigForTPS(): Promise<void> {
    logger.info('Starting TPS optimization configuration...');

    await this.setSpeedLimit();
    await this.setL2GasBacklogTolerance();
    await this.setL2GasPricingInertia();
    await this.setL1PricePerUnit();
    await this.setMinimumL2BaseFeeToLowerBound();

    logger.success('TPS optimization configuration completed!');
  }

  /**
   * Set the speed limit (gas per second target) via ArbOwner.
   * Default value: 150,000,000
   */
  private async setSpeedLimit(): Promise<void> {
    const env = await this.getChainEnvContext();
    if (!env) return;

    const { orbitChainPublicClient, signer, orbitRpcUrl } = env;
    const value = TPS_CONFIG.SPEED_LIMIT;

    logger.info(`Preparing transaction: setSpeedLimit(${value}) on ${orbitRpcUrl}`);
    const txRequest = await orbitChainPublicClient.arbOwnerPrepareTransactionRequest({
      functionName: 'setSpeedLimit',
      args: [value],
      upgradeExecutor: false,
      account: signer.address,
    });

    const txHash = await orbitChainPublicClient.sendRawTransaction({
      serializedTransaction: await signer.signTransaction(txRequest),
    });

    const receipt = await orbitChainPublicClient.waitForTransactionReceipt({ hash: txHash });
    logger.txHash(txHash, 'setSpeedLimit', receipt.status);
    logger.success(`Speed limit set to ${value} (tx status: ${receipt.status})`);
  }

  /**
   * Set the L2 gas backlog tolerance via ArbOwner.
   * High tolerance value: 100,000
   */
  private async setL2GasBacklogTolerance(): Promise<void> {
    const env = await this.getChainEnvContext();
    if (!env) return;

    const { orbitChainPublicClient, signer, orbitRpcUrl } = env;
    const value = TPS_CONFIG.L2_GAS_BACKLOG_TOLERANCE;

    logger.info(`Preparing transaction: setL2GasBacklogTolerance(${value}) on ${orbitRpcUrl}`);
    const txRequest = await orbitChainPublicClient.arbOwnerPrepareTransactionRequest({
      functionName: 'setL2GasBacklogTolerance',
      args: [value],
      upgradeExecutor: false,
      account: signer.address,
    });

    const txHash = await orbitChainPublicClient.sendRawTransaction({
      serializedTransaction: await signer.signTransaction(txRequest),
    });

    const receipt = await orbitChainPublicClient.waitForTransactionReceipt({ hash: txHash });
    logger.txHash(txHash, 'setL2GasBacklogTolerance', receipt.status);
    logger.success(`L2 gas backlog tolerance set to ${value} (tx status: ${receipt.status})`);
  }

  /**
   * Set the L2 gas pricing inertia via ArbOwner.
   * High inertia value: 100,000
   */
  private async setL2GasPricingInertia(): Promise<void> {
    const env = await this.getChainEnvContext();
    if (!env) return;

    const { orbitChainPublicClient, signer, orbitRpcUrl } = env;
    const value = TPS_CONFIG.L2_GAS_PRICING_INERTIA;

    logger.info(`Preparing transaction: setL2GasPricingInertia(${value}) on ${orbitRpcUrl}`);
    const txRequest = await orbitChainPublicClient.arbOwnerPrepareTransactionRequest({
      functionName: 'setL2GasPricingInertia',
      args: [value],
      upgradeExecutor: false,
      account: signer.address,
    });

    const txHash = await orbitChainPublicClient.sendRawTransaction({
      serializedTransaction: await signer.signTransaction(txRequest),
    });

    const receipt = await orbitChainPublicClient.waitForTransactionReceipt({ hash: txHash });
    logger.txHash(txHash, 'setL2GasPricingInertia', receipt.status);
    logger.success(`L2 gas pricing inertia set to ${value} (tx status: ${receipt.status})`);
  }

  /**
   * Set the L1 price per unit via ArbOwner.
   * Value: 0 (no poster fee)
   */
  private async setL1PricePerUnit(): Promise<void> {
    const env = await this.getChainEnvContext();
    if (!env) return;

    const { orbitChainPublicClient, signer, orbitRpcUrl } = env;
    const value = TPS_CONFIG.L1_PRICE_PER_UNIT;

    logger.info(`Preparing transaction: setL1PricePerUnit(${value}) on ${orbitRpcUrl}`);
    const txRequest = await orbitChainPublicClient.arbOwnerPrepareTransactionRequest({
      functionName: 'setL1PricePerUnit',
      args: [value],
      upgradeExecutor: false,
      account: signer.address,
    });

    const txHash = await orbitChainPublicClient.sendRawTransaction({
      serializedTransaction: await signer.signTransaction(txRequest),
    });

    const receipt = await orbitChainPublicClient.waitForTransactionReceipt({ hash: txHash });
    logger.txHash(txHash, 'setL1PricePerUnit', receipt.status);
    logger.success(`L1 price per unit set to ${value} (tx status: ${receipt.status})`);
  }
}

export const manageChainOperations = new ManageChainOperations();
export default manageChainOperations;
