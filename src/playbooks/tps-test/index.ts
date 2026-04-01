import inquirer from 'inquirer';
import { privateKeyToAccount } from 'viem/accounts';
import { Playbook } from '../types.js';
import logger from '../../utils/logger.js';
import { breadcrumb } from '../../utils/breadcrumb.js';
import { ChainEnv } from '../../state/chainEnv/index.js';
import { OperationMode } from '../../types/index.js';
import { runTpsTest } from './tpsRunner.js';
import { setupDex } from './setupDex.js';
import { deployToken } from './deployToken.js';
import { deployUniswap } from './deployUniswap.js';
import { TxMix } from './types.js';

// Default pre-funded dev account from nitro-devnode
const DEVNODE_FUNDER_PRIVATE_KEY = '0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659';

/**
 * Get the address from a private key
 */
function getAddressFromPrivateKey(privateKey: string): string {
  try {
    const account = privateKeyToAccount(privateKey as `0x${string}`);
    return account.address;
  } catch {
    return 'Invalid private key';
  }
}

/**
 * Menu actions for the TPS Test Playbook
 */
enum TpsTestAction {
  QUICK_TEST = 'quick_test',
  MEDIUM_TEST = 'medium_test',
  STRESS_TEST = 'stress_test',
  CUSTOM_TEST = 'custom_test',
  MIXED_TEST = 'mixed_test',
  DEPLOY_TOKEN = 'deploy_token',
  DEPLOY_UNISWAP = 'deploy_uniswap',
  SETUP_DEX = 'setup_dex',
  BACK = 'back',
}

/**
 * TPS Test Playbook
 *
 * Comprehensive stress testing tool for measuring the maximum TPS
 * of Arbitrum Nitro nodes. Features proper nonce management,
 * parallel transaction broadcasting, and deep on-chain verification.
 */
class TpsTestPlaybook implements Playbook {
  id = 'tps-test';
  name = 'TPS Battle Test';
  description = 'Stress test Arbitrum Nitro nodes for maximum TPS';
  supportedModes = [OperationMode.CHAIN, OperationMode.DEVNODE, OperationMode.REMOTE_RPC];

  /**
   * Get ChainEnv singleton instance
   */
  private get chainEnv(): ChainEnv {
    return ChainEnv.getInstance();
  }

  /**
   * Get the default funder private key based on operation mode
   * - Devnode mode: uses the pre-funded dev account
   * - Chain/Remote RPC mode: uses MAIN_PRIVATE_KEY from environment
   */
  private getDefaultFunderPrivateKey(): string {
    if (this.chainEnv.operationMode === OperationMode.DEVNODE) {
      return DEVNODE_FUNDER_PRIVATE_KEY;
    }
    // For chain mode and remote RPC mode, use MAIN_PRIVATE_KEY
    return process.env.MAIN_PRIVATE_KEY || DEVNODE_FUNDER_PRIVATE_KEY;
  }

  /**
   * Get the funder prompt message with address display
   */
  private getFunderPromptMessage(privateKey: string): string {
    const address = getAddressFromPrivateKey(privateKey);
    return `Funder private key (Empty will use the default ${address}):`;
  }

  /**
   * Get RPC URL from ChainEnv or default
   */
  private getRpcUrl(): string {
    // In remote RPC mode, use the configured remote RPC URL
    if (this.chainEnv.operationMode === OperationMode.REMOTE_RPC && this.chainEnv.remoteRpcUrl) {
      return this.chainEnv.remoteRpcUrl;
    }

    // Try to get from running nodes
    const nodes = this.chainEnv.nodeManager?.getRunningNodes() ?? [];
    if (nodes.length > 0 && nodes[0].config?.httpPort) {
      return `http://127.0.0.1:${nodes[0].config.httpPort}`;
    }
    // Default to standard dev node
    return process.env.RPC_URL || 'http://127.0.0.1:8547';
  }

  /**
   * Show the TPS test playbook menu
   */
  async showMenu(): Promise<void> {
    breadcrumb.push('TPS Battle Test');
    logger.raw('Comprehensive stress testing tool for measuring maximum TPS.');
    logger.raw('Supports ETH transfers, ERC20 token transfers, and Uniswap swaps.');
    logger.newline();
    logger.warn('⚠️  This is a TypeScript-based TPS tool — due to Node.js single-threaded nature,');
    logger.warn('   it cannot fully saturate chain throughput under high concurrency.');
    logger.warn('   For serious TPS benchmarking, use a multi-threaded tool (e.g. Go/Rust). This is just for fun!');
    logger.newline();

    while (true) {
      breadcrumb.render();
      const { action } = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: 'Select an action:',
          choices: [
            new inquirer.Separator('── Quick Tests ──'),
            { name: '🚀 Quick Test (5000 txs, 500 senders)', value: TpsTestAction.QUICK_TEST },
            { name: '📊 Medium Test (10,000 txs, 1000 senders)', value: TpsTestAction.MEDIUM_TEST },
            { name: '🔥 Stress Test (50,000 txs, 5000 senders)', value: TpsTestAction.STRESS_TEST },
            new inquirer.Separator('── Custom Tests ──'),
            { name: '⚙️  Custom Test (configure parameters)', value: TpsTestAction.CUSTOM_TEST },
            { name: '🔀 Mixed Transaction Test (ETH + Token + Swap)', value: TpsTestAction.MIXED_TEST },
            new inquirer.Separator('── Contract Deployment ──'),
            { name: '🪙 Deploy ERC20 Token', value: TpsTestAction.DEPLOY_TOKEN },
            { name: '🦄 Deploy Uniswap V2', value: TpsTestAction.DEPLOY_UNISWAP },
            { name: '💱 Setup Full DEX (Token + Uniswap + Liquidity)', value: TpsTestAction.SETUP_DEX },
            new inquirer.Separator(),
            { name: '← Back to Playbook List', value: TpsTestAction.BACK },
          ],
        },
      ]);

      try {
        switch (action) {
          case TpsTestAction.QUICK_TEST:
            await this.runQuickTest();
            break;
          case TpsTestAction.MEDIUM_TEST:
            await this.runMediumTest();
            break;
          case TpsTestAction.STRESS_TEST:
            await this.runStressTest();
            break;
          case TpsTestAction.CUSTOM_TEST:
            await this.runCustomTest();
            break;
          case TpsTestAction.MIXED_TEST:
            await this.runMixedTest();
            break;
          case TpsTestAction.DEPLOY_TOKEN:
            await this.handleDeployToken();
            break;
          case TpsTestAction.DEPLOY_UNISWAP:
            await this.handleDeployUniswap();
            break;
          case TpsTestAction.SETUP_DEX:
            await this.handleSetupDex();
            break;
          case TpsTestAction.BACK:
            breadcrumb.pop();
            return;
        }
      } catch (error) {
        logger.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }

      logger.newline();
    }
  }

  /**
   * Run quick test (5000 txs)
   */
  private async runQuickTest(): Promise<void> {
    logger.section('Quick TPS Test');

    const defaultKey = this.getDefaultFunderPrivateKey();
    const answers = await inquirer.prompt([
      {
        type: 'password',
        name: 'funderPrivateKey',
        message: this.getFunderPromptMessage(defaultKey),
        default: defaultKey,
        mask: '*',
      },
      {
        type: 'number',
        name: 'senderCount',
        message: 'Number of sender accounts:',
        default: 500,
      },
      {
        type: 'number',
        name: 'concurrentRequests',
        message: 'Max concurrent HTTP requests:',
        default: 300,
      },
      {
        type: 'number',
        name: 'gasMultiplier',
        message: 'Gas price multiplier:',
        default: 4,
      },
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Run quick test with 5000 transactions?',
        default: true,
      },
    ]);

    if (!answers.confirm) return;

    await runTpsTest({
      rpcUrl: this.getRpcUrl(),
      funderPrivateKey: answers.funderPrivateKey,
      txCount: 5000,
      senderCount: answers.senderCount,
      concurrentRequests: answers.concurrentRequests,
      gasMultiplier: answers.gasMultiplier,
    });
  }

  /**
   * Run medium test (10000 txs)
   */
  private async runMediumTest(): Promise<void> {
    logger.section('Medium TPS Test');

    const defaultKey = this.getDefaultFunderPrivateKey();
    const answers = await inquirer.prompt([
      {
        type: 'password',
        name: 'funderPrivateKey',
        message: this.getFunderPromptMessage(defaultKey),
        default: defaultKey,
        mask: '*',
      },
      {
        type: 'number',
        name: 'senderCount',
        message: 'Number of sender accounts:',
        default: 1000,
      },
      {
        type: 'number',
        name: 'concurrentRequests',
        message: 'Max concurrent HTTP requests:',
        default: 800,
      },
      {
        type: 'number',
        name: 'gasMultiplier',
        message: 'Gas price multiplier:',
        default: 4,
      },
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Run medium test with 10,000 transactions?',
        default: true,
      },
    ]);

    if (!answers.confirm) return;

    await runTpsTest({
      rpcUrl: this.getRpcUrl(),
      funderPrivateKey: answers.funderPrivateKey,
      txCount: 10000,
      senderCount: answers.senderCount,
      concurrentRequests: answers.concurrentRequests,
      gasMultiplier: answers.gasMultiplier,
    });
  }

  /**
   * Run stress test (50000 txs)
   */
  private async runStressTest(): Promise<void> {
    logger.section('Stress TPS Test');

    const defaultKey = this.getDefaultFunderPrivateKey();
    const answers = await inquirer.prompt([
      {
        type: 'password',
        name: 'funderPrivateKey',
        message: this.getFunderPromptMessage(defaultKey),
        default: defaultKey,
        mask: '*',
      },
      {
        type: 'number',
        name: 'senderCount',
        message: 'Number of sender accounts:',
        default: 5000,
      },
      {
        type: 'number',
        name: 'concurrentRequests',
        message: 'Max concurrent HTTP requests:',
        default: 2000,
      },
      {
        type: 'number',
        name: 'gasMultiplier',
        message: 'Gas price multiplier:',
        default: 4,
      },
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Run stress test with 50,000 transactions? This may take several minutes.',
        default: true,
      },
    ]);

    if (!answers.confirm) return;

    await runTpsTest({
      rpcUrl: this.getRpcUrl(),
      funderPrivateKey: answers.funderPrivateKey,
      txCount: 50000,
      senderCount: answers.senderCount,
      concurrentRequests: answers.concurrentRequests,
      gasMultiplier: answers.gasMultiplier,
    });
  }

  /**
   * Run custom test with user-specified parameters
   */
  private async runCustomTest(): Promise<void> {
    logger.section('Custom TPS Test');

    const defaultKey = this.getDefaultFunderPrivateKey();
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'rpcUrl',
        message: 'RPC URL:',
        default: this.getRpcUrl(),
      },
      {
        type: 'password',
        name: 'funderPrivateKey',
        message: this.getFunderPromptMessage(defaultKey),
        default: defaultKey,
        mask: '*',
      },
      {
        type: 'number',
        name: 'txCount',
        message: 'Total transactions to send:',
        default: 1000,
      },
      {
        type: 'number',
        name: 'senderCount',
        message: 'Number of sender accounts:',
        default: 50,
      },
      {
        type: 'number',
        name: 'concurrentRequests',
        message: 'Max concurrent HTTP requests:',
        default: 200,
      },
      {
        type: 'number',
        name: 'gasMultiplier',
        message: 'Gas price multiplier:',
        default: 4,
      },
      {
        type: 'confirm',
        name: 'verifyAll',
        message: 'Verify all transactions individually?',
        default: false,
      },
    ]);

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Run test with ${answers.txCount} transactions?`,
        default: true,
      },
    ]);

    if (!confirm) return;

    await runTpsTest({
      rpcUrl: answers.rpcUrl,
      funderPrivateKey: answers.funderPrivateKey,
      txCount: answers.txCount,
      senderCount: answers.senderCount,
      concurrentRequests: answers.concurrentRequests,
      gasMultiplier: answers.gasMultiplier,
      verifyAll: answers.verifyAll,
    });
  }

  /**
   * Run mixed transaction test (ETH + Token + Swap)
   */
  private async runMixedTest(): Promise<void> {
    logger.section('Mixed Transaction Test');
    logger.raw('This test requires Token and Uniswap contracts to be deployed.');
    logger.raw('Contracts will be deployed automatically if not provided.');
    logger.newline();

    const defaultKey = this.getDefaultFunderPrivateKey();
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'rpcUrl',
        message: 'RPC URL:',
        default: this.getRpcUrl(),
      },
      {
        type: 'password',
        name: 'funderPrivateKey',
        message: this.getFunderPromptMessage(defaultKey),
        default: defaultKey,
        mask: '*',
      },
      {
        type: 'number',
        name: 'txCount',
        message: 'Total transactions to send:',
        default: 1000,
      },
      {
        type: 'number',
        name: 'senderCount',
        message: 'Number of sender accounts:',
        default: 50,
      },
      {
        type: 'number',
        name: 'concurrentRequests',
        message: 'Max concurrent HTTP requests:',
        default: 100,
      },
      {
        type: 'number',
        name: 'gasMultiplier',
        message: 'Gas price multiplier:',
        default: 4,
      },
      {
        type: 'number',
        name: 'ethPercent',
        message: 'ETH transfer percentage (0-100):',
        default: 50,
      },
      {
        type: 'number',
        name: 'tokenPercent',
        message: 'Token transfer percentage (0-100):',
        default: 30,
      },
    ]);

    // Calculate swap percentage
    const swapPercent = Math.max(0, 100 - answers.ethPercent - answers.tokenPercent);
    logger.info(`Swap percentage: ${swapPercent}% (auto-calculated)`);

    if (answers.ethPercent + answers.tokenPercent > 100) {
      logger.error('ETH + Token percentages cannot exceed 100%');
      return;
    }

    const txMix: TxMix = {
      ethTransfer: answers.ethPercent,
      tokenTransfer: answers.tokenPercent,
      swap: swapPercent,
    };

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Run test with ${txMix.ethTransfer}% ETH, ${txMix.tokenTransfer}% Token, ${txMix.swap}% Swap?`,
        default: true,
      },
    ]);

    if (!confirm) return;

    await runTpsTest({
      rpcUrl: answers.rpcUrl,
      funderPrivateKey: answers.funderPrivateKey,
      txCount: answers.txCount,
      senderCount: answers.senderCount,
      concurrentRequests: answers.concurrentRequests,
      gasMultiplier: answers.gasMultiplier,
      txMix,
    });
  }

  /**
   * Deploy ERC20 Token
   */
  private async handleDeployToken(): Promise<void> {
    logger.section('Deploy ERC20 Token');

    const defaultKey = this.getDefaultFunderPrivateKey();
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'rpcUrl',
        message: 'RPC URL:',
        default: this.getRpcUrl(),
      },
      {
        type: 'password',
        name: 'deployerPrivateKey',
        message: this.getFunderPromptMessage(defaultKey),
        default: defaultKey,
        mask: '*',
      },
      {
        type: 'input',
        name: 'tokenName',
        message: 'Token name:',
        default: 'Test Token',
      },
      {
        type: 'input',
        name: 'tokenSymbol',
        message: 'Token symbol:',
        default: 'TEST',
      },
      {
        type: 'input',
        name: 'initialSupply',
        message: 'Initial supply (without decimals):',
        default: '1000000000',
      },
    ]);

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Deploy ${answers.tokenName} (${answers.tokenSymbol})?`,
        default: true,
      },
    ]);

    if (!confirm) return;

    const result = await deployToken({
      rpcUrl: answers.rpcUrl,
      deployerPrivateKey: answers.deployerPrivateKey,
      tokenName: answers.tokenName,
      tokenSymbol: answers.tokenSymbol,
      initialSupply: answers.initialSupply,
    });

    logger.success(`Token deployed at: ${result.contractAddress}`);
  }

  /**
   * Deploy Uniswap V2
   */
  private async handleDeployUniswap(): Promise<void> {
    logger.section('Deploy Uniswap V2');

    const defaultKey = this.getDefaultFunderPrivateKey();
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'rpcUrl',
        message: 'RPC URL:',
        default: this.getRpcUrl(),
      },
      {
        type: 'password',
        name: 'deployerPrivateKey',
        message: this.getFunderPromptMessage(defaultKey),
        default: defaultKey,
        mask: '*',
      },
    ]);

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Deploy Uniswap V2 (WETH, Factory, Router)?',
        default: true,
      },
    ]);

    if (!confirm) return;

    const result = await deployUniswap({
      rpcUrl: answers.rpcUrl,
      deployerPrivateKey: answers.deployerPrivateKey,
    });

    logger.success(`WETH: ${result.weth.address}`);
    logger.success(`Factory: ${result.factory.address}`);
    logger.success(`Router: ${result.router.address}`);
  }

  /**
   * Setup full DEX (Token + Uniswap + Liquidity)
   */
  private async handleSetupDex(): Promise<void> {
    logger.section('Setup Full DEX');

    const defaultKey = this.getDefaultFunderPrivateKey();
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'rpcUrl',
        message: 'RPC URL:',
        default: this.getRpcUrl(),
      },
      {
        type: 'password',
        name: 'deployerPrivateKey',
        message: this.getFunderPromptMessage(defaultKey),
        default: defaultKey,
        mask: '*',
      },
      {
        type: 'input',
        name: 'tokenName',
        message: 'Token name:',
        default: 'Test Token',
      },
      {
        type: 'input',
        name: 'tokenSymbol',
        message: 'Token symbol:',
        default: 'TEST',
      },
      {
        type: 'input',
        name: 'ethLiquidity',
        message: 'ETH liquidity amount:',
        default: '10',
      },
      {
        type: 'input',
        name: 'tokenLiquidity',
        message: 'Token liquidity amount:',
        default: '100000000',
      },
    ]);

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Deploy Token, Uniswap, and add liquidity?',
        default: true,
      },
    ]);

    if (!confirm) return;

    const result = await setupDex({
      rpcUrl: answers.rpcUrl,
      deployerPrivateKey: answers.deployerPrivateKey,
      token: {
        name: answers.tokenName,
        symbol: answers.tokenSymbol,
        decimals: 18,
        initialSupply: '1000000000',
      },
      liquidity: {
        ethAmount: answers.ethLiquidity,
        tokenAmount: answers.tokenLiquidity,
      },
    });

    logger.success(`Token: ${result.token.address}`);
    logger.success(`WETH: ${result.weth.address}`);
    logger.success(`Router: ${result.router.address}`);
    logger.success(`Pair: ${result.pair.address}`);
  }
}

export const tpsTestPlaybook = new TpsTestPlaybook();
export default tpsTestPlaybook;
