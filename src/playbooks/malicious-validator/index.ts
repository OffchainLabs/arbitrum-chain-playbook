import inquirer from 'inquirer';
import { formatEther, parseEther, type Address } from 'viem';
import { existsSync } from 'fs';
import { copyFile, rm, readdir } from 'fs/promises';
import { execSync } from 'child_process';
import path from 'path';
import { Playbook, PlaybookActionResult, HeadlessCommandSpec } from '../types.js';
import logger from '../../utils/logger.js';
import { StepTracker } from '../../utils/ui.js';
import { NodeType, OperationMode } from '../../types/index.js';
import { overwriteNodeConfigFile } from '../../core/nodeConfig/nodeConfigOperations.js';
import { ChainEnv } from '../../state/chainEnv/index.js';
import { runMaliciousMintDemo } from './maliciousMintRunner.js';
import { runChallengeDemo } from './challengeRunner.js';
import { getRollupStatus } from './monitor.js';
import {
  DEFAULT_MALICIOUS_MINT_CONFIG,
  DEFAULT_CHALLENGE_DEMO_CONFIG,
  type MaliciousMintConfig,
  type MaliciousMintResult,
  type ChallengeDemoConfig,
  type ChallengeDemoResult,
} from './types.js';
import { checkOnChainIsClean } from '../../core/docker/validation.js';
import {
  NODE_CONFIG_FILENAME,
  NODE_CONFIG_MALICIOUS_FILENAME,
  LOCAL_DATA_DIR,
  DOCKER_IMAGE_MALICIOUS,
} from '../../types/constants.js';
import { withCancellation, type OperationContext } from '../../utils/cancellation.js';
import { breadcrumb } from '../../utils/breadcrumb.js';
import { MaliciousMintParamsSchema, BoldChallengeParamsSchema } from '../../scripted/schema.js';
import { positiveNumberValidator } from '../../utils/inquirerUtils.js';
import chalk from 'chalk';

export const HEADLESS_COMMAND_MALICIOUS_MINT = 'malicious-mint';
export const HEADLESS_COMMAND_BOLD_CHALLENGE = 'bold-challenge';

export interface MaliciousMintHeadlessParams {
  mainDepositAmount?: bigint;
  hackerDepositAmount?: bigint;
  hackerFundingAmount?: bigint;
}

export interface BoldChallengeHeadlessParams {
  maxWaitSeconds?: number;
  pollIntervalMs?: number;
  delayedMessageCount?: number;
  delayedMessageAmount?: bigint;
  childChainTxCount?: number;
}

enum MaliciousValidatorAction {
  RUN_MALICIOUS_MINT = 'run_malicious_mint',
  RUN_CHALLENGE_DEMO = 'run_challenge_demo',
  CONFIGURE_MALICIOUS = 'configure_malicious',
  START_MALICIOUS_NODE = 'start_malicious_node',
  VIEW_ROLLUP_STATUS = 'view_rollup_status',
  VIEW_STATUS = 'view_status',
  STOP_NODES = 'stop_nodes',
  BACK = 'back',
}

class MaliciousValidatorPlaybook implements Playbook {
  id = 'malicious-validator';
  name = 'Malicious Validator';
  description = 'Simulate malicious validator behaviors for testing';
  supportedModes = [OperationMode.CHAIN];

  private get chainEnv(): ChainEnv {
    return ChainEnv.getInstance();
  }

  private async validateChainIsClean(): Promise<boolean> {
    const coreContracts = this.chainEnv.chainConfig.getCoreContracts();
    if (!coreContracts) {
      logger.errorWithFix('Core contracts not available.', 'Deploy a chain first from Main Menu > Deploy Chain.');
      return false;
    }

    const chainId = this.chainEnv.chainConfig.getChainId();
    if (!chainId) {
      logger.errorWithFix('Chain ID not available.', 'Deploy a chain first from Main Menu > Deploy Chain.');
      return false;
    }

    const parentClient = this.chainEnv.parentChainClient;
    if (!parentClient) {
      logger.errorWithFix('Parent chain client not available.', 'Set PARENT_CHAIN_RPC in your .env file.');
      return false;
    }

    // Step 1: Check on-chain state. If the rollup has progressed beyond genesis,
    // there is nothing we can do locally — the user must re-deploy.
    const onChainClean = await checkOnChainIsClean({
      parentClient,
      sequencerInboxAddress: coreContracts.sequencerInbox as Address,
    });

    if (!onChainClean) {
      logger.errorWithFix(
        'Rollup has progressed beyond genesis.',
        'Re-deploy the chain from Main Menu > Deploy Chain to start fresh.',
      );
      return false;
    }

    // Step 2: Check local DB. If dirty but on-chain is clean, auto-delete — but only
    // when no node is currently running. A running node owns the DB; deleting it
    // while the process is live causes a Pebble WAL panic and data loss.
    const runningNodes = this.chainEnv.nodeManager?.getRunningNodes() ?? [];
    if (runningNodes.length > 0) {
      // A node is alive and owns the DB. That is fine — the demo will use it.
      return true;
    }

    const chainDir = path.join(process.cwd(), LOCAL_DATA_DIR, chainId.toString());
    let localDbDirty = false;
    try {
      const entries = await readdir(chainDir);
      localDbDirty = entries.some((e) => e !== '.DS_Store');
    } catch {
      // Directory does not exist — already clean.
    }

    if (localDbDirty) {
      logger.info(`Local DB has leftover data. Cleaning ${chainDir}...`);
      await rm(chainDir, { recursive: true, force: true });
      logger.success('Local DB cleaned.');
    }

    return true;
  }

  async showMenu(): Promise<void> {
    breadcrumb.push('Malicious Validator');
    logger.raw('This playbook helps you simulate and test malicious validator behaviors.');
    logger.newline();

    while (true) {
      breadcrumb.render();
      const { action } = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: 'Select an action:',
          choices: [
            {
              name: `Run Malicious Mint Demo ${chalk.dim('— Full cross-chain malicious mint flow')}`,
              value: MaliciousValidatorAction.RUN_MALICIOUS_MINT,
            },
            {
              name: `Run Challenge Demo ${chalk.dim('— Honest vs malicious validator challenge')}`,
              value: MaliciousValidatorAction.RUN_CHALLENGE_DEMO,
            },
            new inquirer.Separator(),
            {
              name: `Start Malicious Node ${chalk.dim('— Launch a misconfigured validator')}`,
              value: MaliciousValidatorAction.START_MALICIOUS_NODE,
            },
            {
              name: `Configure Malicious Validator ${chalk.dim('— Modify node-config.json')}`,
              value: MaliciousValidatorAction.CONFIGURE_MALICIOUS,
            },
            {
              name: `View Rollup Status ${chalk.dim('— Check on-chain rollup state')}`,
              value: MaliciousValidatorAction.VIEW_ROLLUP_STATUS,
            },
            {
              name: `View Node Status ${chalk.dim('— Show running node info')}`,
              value: MaliciousValidatorAction.VIEW_STATUS,
            },
            {
              name: `Stop All Nodes ${chalk.dim('— Terminate all running nodes')}`,
              value: MaliciousValidatorAction.STOP_NODES,
            },
            new inquirer.Separator(),
            { name: '← Back to Playbook List', value: MaliciousValidatorAction.BACK },
          ],
        },
      ]);

      switch (action) {
        case MaliciousValidatorAction.RUN_MALICIOUS_MINT:
          await this.handleRunMaliciousMint();
          break;
        case MaliciousValidatorAction.RUN_CHALLENGE_DEMO:
          await this.handleRunChallengeDemo();
          break;
        case MaliciousValidatorAction.CONFIGURE_MALICIOUS:
          await this.handleConfigureMalicious();
          break;
        case MaliciousValidatorAction.START_MALICIOUS_NODE:
          await this.handleStartMaliciousNode();
          break;
        case MaliciousValidatorAction.VIEW_ROLLUP_STATUS:
          await this.handleViewRollupStatus();
          break;
        case MaliciousValidatorAction.VIEW_STATUS:
          this.handleViewStatus();
          break;
        case MaliciousValidatorAction.STOP_NODES:
          await this.handleStopNodes();
          break;
        case MaliciousValidatorAction.BACK:
          breadcrumb.pop();
          return;
      }

      logger.newline();
    }
  }

  private async handleRunMaliciousMint(): Promise<void> {
    logger.section('Run Malicious Mint Demo');
    logger.raw('This demo will:');
    logger.raw('  1. Deploy chain with confirmPeriodBlocks=16');
    logger.raw('  2. Start node (malicious ArbMinter image)');
    logger.raw('  3. Deposit ETH from parent chain to child chain');
    logger.raw('  4. Generate a random Hacker account and fund it');
    logger.raw('  5. Hacker calls ArbMinter.mintBalanceTo (malicious minting)');
    logger.raw('  6. Hacker withdraws the minted funds back to L1');
    logger.raw('  7. Monitor rollup and wait for withdrawal execution');
    logger.newline();
    logger.warn('Note: This will redeploy your chain (existing chain data will be deleted).');
    logger.newline();

    // Prompt for configuration
    const { useDefaults } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'useDefaults',
        message: `Use default amounts? (Main: ${formatEther(DEFAULT_MALICIOUS_MINT_CONFIG.mainDepositAmount)} ETH, Hacker: ${formatEther(DEFAULT_MALICIOUS_MINT_CONFIG.hackerDepositAmount)} ETH)`,
        default: true,
      },
    ]);

    let config = DEFAULT_MALICIOUS_MINT_CONFIG;

    if (!useDefaults) {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'mainDepositAmount',
          message: 'Main deposit amount (ETH):',
          default: '0.05',
          validate: positiveNumberValidator(),
        },
        {
          type: 'input',
          name: 'hackerDepositAmount',
          message: 'B deposit amount (ETH):',
          default: '0.001',
          validate: positiveNumberValidator(),
        },
        {
          type: 'input',
          name: 'hackerFundingAmount',
          message: 'B funding amount for gas (ETH):',
          default: '0.002',
          validate: positiveNumberValidator(),
        },
      ]);

      config = {
        mainDepositAmount: parseEther(answers.mainDepositAmount),
        hackerDepositAmount: parseEther(answers.hackerDepositAmount),
        hackerFundingAmount: parseEther(answers.hackerFundingAmount),
      };
    }

    // Confirm before running
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'This will redeploy the chain and execute real transactions. Continue?',
        default: true,
      },
    ]);

    if (!confirm) {
      logger.info('Demo cancelled.');
      return;
    }

    const result = await withCancellation('Malicious Mint Demo', (ctx) => this.executeMaliciousMint(config, ctx));
    if (!result) return; // cancelled
  }

  // Shared core for malicious-mint, used by both the menu handler and the
  // headless runner. Returns the demo result, or null if the run failed in a
  // way the caller should treat as a soft failure (errors already logged).
  private async executeMaliciousMint(
    config: MaliciousMintConfig,
    ctx: OperationContext,
  ): Promise<MaliciousMintResult | null> {
    try {
      return await runMaliciousMintDemo(config, ctx);
    } catch (error) {
      logger.errorWithFix(
        `Demo failed: ${error instanceof Error ? error.message : String(error)}`,
        'Check Docker status, node logs (`docker logs <container>`), and account balances.',
      );
      return null;
    }
  }

  private async handleRunChallengeDemo(): Promise<void> {
    logger.section('Run Challenge Demo');
    logger.raw('This demo will:');
    logger.raw('  1. Deploy chain with confirmPeriodBlocks=1600');
    logger.raw('  2. Generate malicious + honest node configs');
    logger.raw('  3. Start malicious node (ReadInboxMessage bit-flip)');
    logger.raw('  4. Start honest validator node');
    logger.raw('  5. Send delayed messages (L1 deposits for non-linear bisection)');
    logger.raw('  6. Send L2 transactions to trigger divergence');
    logger.raw('  7. Monitor BoLD challenge until EdgeConfirmedByOneStepProof');
    logger.newline();
    logger.warn('Note: This will redeploy your chain (existing chain data will be deleted).');
    logger.warn('      The challenge process can take 30-60 minutes.');
    logger.newline();

    // Prompt for configuration
    const maxWaitMin = Math.floor(DEFAULT_CHALLENGE_DEMO_CONFIG.maxWaitSeconds / 60);
    const { useDefaults } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'useDefaults',
        message: `Use default configuration? (Max wait: ${maxWaitMin} min, ${DEFAULT_CHALLENGE_DEMO_CONFIG.delayedMessageCount} delayed messages)`,
        default: true,
      },
    ]);

    let config = DEFAULT_CHALLENGE_DEMO_CONFIG;

    if (!useDefaults) {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'maxWaitSeconds',
          message: 'Maximum wait time for challenge (seconds):',
          default: String(DEFAULT_CHALLENGE_DEMO_CONFIG.maxWaitSeconds),
          validate: positiveNumberValidator((s) => parseInt(s, 10)),
        },
        {
          type: 'input',
          name: 'delayedMessageCount',
          message: 'Number of delayed messages (L1 deposits):',
          default: String(DEFAULT_CHALLENGE_DEMO_CONFIG.delayedMessageCount),
          validate: positiveNumberValidator((s) => parseInt(s, 10)),
        },
        {
          type: 'input',
          name: 'childChainTxCount',
          message: 'Number of L2 transactions:',
          default: String(DEFAULT_CHALLENGE_DEMO_CONFIG.childChainTxCount),
          validate: positiveNumberValidator((s) => parseInt(s, 10)),
        },
      ]);

      config = {
        ...DEFAULT_CHALLENGE_DEMO_CONFIG,
        maxWaitSeconds: parseInt(answers.maxWaitSeconds, 10),
        delayedMessageCount: parseInt(answers.delayedMessageCount, 10),
        childChainTxCount: parseInt(answers.childChainTxCount, 10),
      };
    }

    // Confirm before running
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'This will redeploy the chain and start multiple nodes. Continue?',
        default: true,
      },
    ]);

    if (!confirm) {
      logger.info('Demo cancelled.');
      return;
    }

    const result = await withCancellation('Challenge Demo', (ctx) => this.executeChallengeDemo(config, ctx));
    if (!result) return; // cancelled or precondition failed
  }

  // Shared core for bold-challenge. Performs the docker-image precondition
  // check (was previously in handleRunChallengeDemo) so the headless path
  // gets the same gate. Returns null on failure or cancellation.
  private async executeChallengeDemo(
    config: ChallengeDemoConfig,
    ctx: OperationContext,
  ): Promise<ChallengeDemoResult | null> {
    try {
      execSync(`docker image inspect ${DOCKER_IMAGE_MALICIOUS}`, { stdio: 'ignore' });
    } catch {
      logger.errorWithFix(
        `Docker image "${DOCKER_IMAGE_MALICIOUS}" not found locally.`,
        'You need to build it first. See the "Build Malicious Validator Image" section in README.md for instructions.',
      );
      return null;
    }

    try {
      const result = await runChallengeDemo(config, ctx);
      if (result.success) {
        logger.success('Challenge demo completed successfully!');
      } else {
        logger.warn('Challenge demo completed but challenge may still be in progress.');
      }
      return result;
    } catch (error) {
      logger.errorWithFix(
        `Challenge demo failed: ${error instanceof Error ? error.message : String(error)}`,
        'Check Docker status, node logs (`docker logs <container>`), and PARENT_CHAIN_RPC connectivity.',
      );
      return null;
    }
  }

  private async handleViewRollupStatus(): Promise<void> {
    logger.section('Rollup Status');

    const coreContracts = this.chainEnv.chainConfig.getCoreContracts();
    const parentClient = this.chainEnv.parentChainClient;

    if (!coreContracts || !parentClient) {
      logger.errorWithFix(
        'Chain not connected.',
        'Deploy a chain first from Main Menu > Deploy Chain, or connect via Remote RPC mode.',
      );
      return;
    }

    try {
      const status = await getRollupStatus(parentClient, coreContracts);

      logger.info(`Rollup: ${coreContracts.rollup}`);
      logger.info(`SequencerInbox: ${coreContracts.sequencerInbox}`);
      logger.newline();
      logger.raw('Current Status:');
      logger.raw(`  Batch Count: ${status.batchCount}`);
      logger.raw(`  Latest Confirmed: ${status.latestConfirmed}`);
      logger.raw(`  Staker Count: ${status.stakerCount}`);
      logger.raw(`  Confirm Period Blocks: ${status.confirmPeriodBlocks}`);
    } catch (error) {
      logger.errorWithFix(
        `Failed to fetch rollup status: ${error instanceof Error ? error.message : String(error)}`,
        'Verify PARENT_CHAIN_RPC is set and reachable.',
      );
    }
  }

  private async handleConfigureMalicious(): Promise<void> {
    logger.section('Configure Malicious Validator');

    const { configType } = await inquirer.prompt([
      {
        type: 'list',
        name: 'configType',
        message: 'Select malicious configuration type:',
        choices: [
          { name: 'Without Block Validator (skip block validation)', value: 'malicious-validator' },
          { name: 'Incorrect WASM Module (use wrong WASM)', value: 'incorrect-wasm-validator' },
          new inquirer.Separator(),
          { name: '← Cancel', value: 'cancel' },
        ],
      },
    ]);

    if (configType === 'cancel') {
      return;
    }

    try {
      await overwriteNodeConfigFile(configType);
      logger.success(`Successfully configured node-config.json for ${configType}`);
      logger.info('You can now start a malicious node with this configuration.');
    } catch (error) {
      logger.errorWithFix(
        `Failed to configure: ${error instanceof Error ? error.message : String(error)}`,
        'Ensure node-config.json exists. Deploy a chain first (Main Menu > Deploy Chain) to generate it.',
      );
    }
  }

  private async handleStartMaliciousNode(): Promise<void> {
    logger.section('Start Malicious Node');

    if (!this.chainEnv.status.isInitiated()) {
      if (!this.chainEnv.load()) {
        logger.errorWithFix('No chain detected.', 'Deploy a chain first from Main Menu > Deploy Chain.');
        return;
      }
    }

    if (!(await this.validateChainIsClean())) {
      return;
    }

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Start a malicious validator node?',
        default: true,
      },
    ]);

    if (!confirm) {
      return;
    }

    const mainConfigPath = path.join(process.cwd(), NODE_CONFIG_FILENAME);
    const maliciousConfigPath = path.join(process.cwd(), NODE_CONFIG_MALICIOUS_FILENAME);

    if (!existsSync(mainConfigPath)) {
      logger.errorWithFix(
        `Main node config file not found: ${mainConfigPath}`,
        'Deploy a chain first from Main Menu > Deploy Chain to generate the config file.',
      );
      return;
    }

    const nodeManager = this.chainEnv.nodeManager;
    if (!nodeManager) {
      logger.errorWithFix(
        'NodeManager not available.',
        'Deploy a chain first (Main Menu > Deploy Chain) so that the node manager is initialized.',
      );
      return;
    }

    const needsConfigCreation = !existsSync(maliciousConfigPath);

    try {
      const result = await withCancellation('Start Malicious Node', async (ctx) => {
        const steps = [
          ...(needsConfigCreation ? ['Creating malicious config file'] : []),
          'Applying Fast Batch Poster configuration',
          'Applying Deleting Bold Strategy configuration',
          'Applying Malicious Validator configuration',
          'Starting malicious node',
        ];

        const tracker = new StepTracker(steps);
        ctx.onCleanup(async () => tracker.fail('Cancelled'));

        if (needsConfigCreation) {
          ctx.throwIfCancelled();
          ctx.stepStarted('Creating malicious config file');
          tracker.start();
          await copyFile(mainConfigPath, maliciousConfigPath);
          ctx.stepCompleted('Creating malicious config file');
        }

        ctx.throwIfCancelled();
        ctx.stepStarted('Applying Fast Batch Poster configuration');
        tracker.start();
        await overwriteNodeConfigFile('fast-batch-poster', maliciousConfigPath);
        ctx.stepCompleted('Applying Fast Batch Poster configuration');

        ctx.throwIfCancelled();
        ctx.stepStarted('Applying Deleting Bold Strategy configuration');
        tracker.start();
        await overwriteNodeConfigFile('deleting-bold-strategy', maliciousConfigPath);
        ctx.stepCompleted('Applying Deleting Bold Strategy configuration');

        ctx.throwIfCancelled();
        ctx.stepStarted('Applying Malicious Validator configuration');
        tracker.start();
        await overwriteNodeConfigFile('malicious-validator', maliciousConfigPath);
        ctx.stepCompleted('Applying Malicious Validator configuration');

        ctx.throwIfCancelled();
        ctx.stepStarted('Starting malicious node');
        tracker.start();
        await nodeManager.startNode(NodeType.MALICIOUS);
        ctx.stepCompleted('Starting malicious node');

        tracker.complete('Malicious node started successfully!');
        return true;
      });
      if (!result) return; // cancelled
    } catch (error) {
      logger.errorWithFix(
        `Failed to configure malicious node: ${error instanceof Error ? error.message : String(error)}`,
        'Ensure node-config.json exists and Docker is running.',
      );
    }
  }

  private handleViewStatus(): void {
    if (this.chainEnv.nodeManager) {
      this.chainEnv.nodeManager.displayStatus();
    } else {
      logger.raw('No nodes available');
    }
  }

  private async handleStopNodes(): Promise<void> {
    const nodeManager = this.chainEnv.nodeManager;
    if (!nodeManager) {
      logger.info('No node manager available.');
      return;
    }
    const running = nodeManager.getRunningNodes();
    if (running.length === 0) {
      logger.info('No running nodes to stop.');
      return;
    }
    const { confirmStop } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmStop',
        message: `Stop all ${running.length} running node(s)? This will terminate their Docker containers.`,
        default: false,
      },
    ]);
    if (confirmStop) {
      await nodeManager.stopAllNodes();
    }
  }

  // ==========================================================================
  // Headless entry — drives the same execute* methods as the menu handlers,
  // bypassing inquirer. The script runner owns the OperationContext and is
  // responsible for prior shape-validation of `params`.
  // ==========================================================================

  listHeadlessCommands(): HeadlessCommandSpec[] {
    return [
      {
        command: HEADLESS_COMMAND_MALICIOUS_MINT,
        description: 'Run malicious mint demo end-to-end (deploy chain, mint, withdraw, monitor).',
        supportedModes: [OperationMode.CHAIN],
        redeploysChain: true,
        paramsSchema: MaliciousMintParamsSchema,
      },
      {
        command: HEADLESS_COMMAND_BOLD_CHALLENGE,
        description: 'Run BoLD challenge demo (honest vs malicious validator).',
        supportedModes: [OperationMode.CHAIN],
        redeploysChain: true,
        paramsSchema: BoldChallengeParamsSchema,
      },
    ];
  }

  async runHeadless(command: string, params: unknown, ctx?: OperationContext): Promise<PlaybookActionResult> {
    if (!ctx) {
      return { success: false, message: 'runHeadless requires an OperationContext from the script runner.' };
    }

    switch (command) {
      case HEADLESS_COMMAND_MALICIOUS_MINT: {
        const config = mergeMaliciousMintParams(params);
        const result = await this.executeMaliciousMint(config, ctx);
        if (!result?.success) {
          return { success: false, message: 'Malicious mint demo failed or was cancelled.' };
        }
        return { success: true, data: result };
      }

      case HEADLESS_COMMAND_BOLD_CHALLENGE: {
        const config = mergeChallengeDemoParams(params);
        const result = await this.executeChallengeDemo(config, ctx);
        if (!result) {
          return { success: false, message: 'BoLD challenge demo failed or was cancelled.' };
        }
        return { success: result.success, data: result };
      }

      default:
        return {
          success: false,
          message: `Unknown command "${command}". Known: ${this.listHeadlessCommands()
            .map((c) => c.command)
            .join(', ')}`,
        };
    }
  }
}

// Narrowing helpers — assume the script runner has already shape-validated
// params via zod, so we only fill in defaults for omitted fields.
function mergeMaliciousMintParams(params: unknown): MaliciousMintConfig {
  const p = (params ?? {}) as MaliciousMintHeadlessParams;
  return {
    mainDepositAmount: p.mainDepositAmount ?? DEFAULT_MALICIOUS_MINT_CONFIG.mainDepositAmount,
    hackerDepositAmount: p.hackerDepositAmount ?? DEFAULT_MALICIOUS_MINT_CONFIG.hackerDepositAmount,
    hackerFundingAmount: p.hackerFundingAmount ?? DEFAULT_MALICIOUS_MINT_CONFIG.hackerFundingAmount,
  };
}

function mergeChallengeDemoParams(params: unknown): ChallengeDemoConfig {
  const p = (params ?? {}) as BoldChallengeHeadlessParams;
  return {
    maxWaitSeconds: p.maxWaitSeconds ?? DEFAULT_CHALLENGE_DEMO_CONFIG.maxWaitSeconds,
    pollIntervalMs: p.pollIntervalMs ?? DEFAULT_CHALLENGE_DEMO_CONFIG.pollIntervalMs,
    delayedMessageCount: p.delayedMessageCount ?? DEFAULT_CHALLENGE_DEMO_CONFIG.delayedMessageCount,
    delayedMessageAmount: p.delayedMessageAmount ?? DEFAULT_CHALLENGE_DEMO_CONFIG.delayedMessageAmount,
    childChainTxCount: p.childChainTxCount ?? DEFAULT_CHALLENGE_DEMO_CONFIG.childChainTxCount,
  };
}

export const maliciousValidatorPlaybook = new MaliciousValidatorPlaybook();
export default maliciousValidatorPlaybook;
