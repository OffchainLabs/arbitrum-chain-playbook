import inquirer from 'inquirer';
import path from 'path';
import logger from '../../utils/logger.js';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { NODE_CONFIG_FILENAME } from '../../types/constants.js';
import { NodeConfig } from '@arbitrum/chain-sdk';
import { breadcrumb } from '../../utils/breadcrumb.js';
import chalk from 'chalk';
import {
  overwriteToNodeConfigForFastValidator,
  overwriteToNodeConfigForFastBatchPoster,
  overwriteToNodeConfigForIncorrectWasmValidator,
  overwriteToNodeConfigForMaliciousValidator,
  overwriteToNodeConfigForMaliciousMint,
  overwriteToNodeConfigForDeletingBoldStrategy,
} from '../../utils/nodeConfigUtils.js';

// Overwrite options type
export type OverwriteOption =
  | 'fast-validator'
  | 'fast-batch-poster'
  | 'incorrect-wasm-validator'
  | 'malicious-validator'
  | 'malicious-mint'
  | 'deleting-bold-strategy';

// Overwrite option labels
export const OVERWRITE_OPTIONS: Record<OverwriteOption, string> = {
  'fast-validator': 'Fast Validator',
  'fast-batch-poster': 'Fast Batch Poster',
  'incorrect-wasm-validator': 'Incorrect Wasm Validator',
  'malicious-validator': 'Malicious Validator',
  'malicious-mint': 'Malicious Mint (BlockValidator + local WASM)',
  'deleting-bold-strategy': 'Deleting Bold Strategy (For old SDK generated node config)',
};

/**
 * Apply overwrite function to node config based on option
 */
export function applyOverwriteToNodeConfig(nodeConfig: NodeConfig, option: OverwriteOption): NodeConfig {
  switch (option) {
    case 'fast-validator':
      return overwriteToNodeConfigForFastValidator(nodeConfig);
    case 'fast-batch-poster':
      return overwriteToNodeConfigForFastBatchPoster(nodeConfig);
    case 'incorrect-wasm-validator':
      return overwriteToNodeConfigForIncorrectWasmValidator(nodeConfig);
    case 'malicious-validator':
      return overwriteToNodeConfigForMaliciousValidator(nodeConfig);
    case 'malicious-mint':
      return overwriteToNodeConfigForMaliciousMint(nodeConfig);
    case 'deleting-bold-strategy':
      return overwriteToNodeConfigForDeletingBoldStrategy(nodeConfig);
    default:
      return nodeConfig;
  }
}

/**
 * Node Config Operations Module
 * Provides interactive menu for node configuration operations
 */
export class NodeConfigOperations {
  /**
   * Show the node config operations menu
   */
  async showMenu(): Promise<void> {
    breadcrumb.push('Node Config');

    while (true) {
      breadcrumb.render();
      const { action } = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: 'Select an operation:',
          choices: [
            {
              name: `Apply Fast Validator Config ${chalk.dim('— Optimized staker settings')}`,
              value: 'fast-validator',
            },
            {
              name: `Apply Fast Batch Poster Config ${chalk.dim('— Frequent batch posting')}`,
              value: 'fast-batch-poster',
            },
            {
              name: `Apply Incorrect WASM Validator Config ${chalk.dim('— Use wrong WASM module')}`,
              value: 'incorrect-wasm-validator',
            },
            {
              name: `Apply Malicious Validator Config ${chalk.dim('— Skip block validation')}`,
              value: 'malicious-validator',
            },
            {
              name: `Apply Deleting Bold Strategy Config ${chalk.dim('— BoLD deletion mode')}`,
              value: 'deleting-bold-strategy',
            },
            { name: `Overwrite Block Time ${chalk.dim('— Set max-block-speed in ms')}`, value: 'overwrite-block-time' },
            new inquirer.Separator(),
            { name: `Add WebSocket Configuration ${chalk.dim('— Enable WS API access')}`, value: 'add-ws-config' },
            {
              name: `Add Feed Output Configuration ${chalk.dim('— Enable block update broadcast')}`,
              value: 'add-feed-output',
            },
            new inquirer.Separator(),
            { name: '← Back to Main Menu', value: 'back' },
          ],
        },
      ]);

      if (action === 'back') {
        breadcrumb.pop();
        return;
      }

      if (action === 'overwrite-block-time') {
        await this.overwriteBlockTimeMs();
      } else if (action === 'add-ws-config') {
        await this.appendWSConfigToNodeFile();
      } else if (action === 'add-feed-output') {
        await this.addFeedOutputConfig();
      } else {
        await this.applyConfig(action as OverwriteOption);
      }

      logger.newline();

      // Ask if user wants to apply another config
      const { applyAnother } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'applyAnother',
          message: 'Apply another configuration?',
          default: false,
        },
      ]);

      if (!applyAnother) {
        breadcrumb.pop();
        return;
      }
    }
  }

  /**
   * Overwrite execution.sequencer.max-block-speed in node-config.json, prompting user for milliseconds.
   */
  private async overwriteBlockTimeMs(configPath: string = NODE_CONFIG_FILENAME): Promise<void> {
    try {
      if (!existsSync(configPath)) {
        throw new Error(`Node config file not found: ${configPath}`);
      }

      const { ms } = await inquirer.prompt<{ ms: string }>([
        {
          type: 'input',
          name: 'ms',
          message: 'Enter block time (ms):',
          validate: (input: string) => {
            const n = Number(input);
            if (!Number.isFinite(n) || !Number.isInteger(n)) return 'Please enter an integer (milliseconds).';
            if (n <= 0) return 'Please enter a positive integer.';
            return true;
          },
          filter: (input: string) => input.trim(),
        },
      ]);

      const blockTimeMs = Number(ms);

      const fileContent = await readFile(configPath, 'utf-8');
      const nodeConfig: NodeConfig = JSON.parse(fileContent);

      // Force-create the nested objects so this operation always applies.
      const root = nodeConfig as any;
      if (!root.execution || typeof root.execution !== 'object') root.execution = {};
      if (!root.execution.sequencer || typeof root.execution.sequencer !== 'object') root.execution.sequencer = {};

      root.execution.sequencer['max-block-speed'] = `${blockTimeMs}ms`;

      await writeFile(configPath, JSON.stringify(nodeConfig, null, 2));
      logger.success(
        `Successfully set execution.sequencer.max-block-speed to "${blockTimeMs}ms" in ${NODE_CONFIG_FILENAME}`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('not found')) {
        logger.errorWithFix(
          `Failed to overwrite block time: ${msg}`,
          `Ensure ${NODE_CONFIG_FILENAME} exists in the current directory. Deploy a chain first to generate it.`,
        );
      } else {
        logger.errorWithFix(
          `Failed to overwrite block time: ${msg}`,
          `Check that ${NODE_CONFIG_FILENAME} contains valid JSON.`,
        );
      }
    }
  }

  /**
   * Apply a specific configuration to node-config.json
   */
  private async applyConfig(option: OverwriteOption): Promise<void> {
    try {
      await overwriteNodeConfigFile(option);
      logger.success(`Successfully applied "${OVERWRITE_OPTIONS[option]}" to node-config.json`);
    } catch (error) {
      logger.errorWithFix(
        `Failed to apply config: ${error instanceof Error ? error.message : String(error)}`,
        `Ensure ${NODE_CONFIG_FILENAME} exists in the current directory. Deploy a chain first to generate it.`,
      );
    }
  }

  /**
   * Add WebSocket configuration to node-config.json
   */
  private async appendWSConfigToNodeFile(): Promise<void> {
    try {
      const configPath = path.join(process.cwd(), NODE_CONFIG_FILENAME);

      // Check if file exists
      if (!existsSync(configPath)) {
        logger.errorWithFix(
          `Node config file not found: ${configPath}`,
          'Deploy a chain first (Main Menu > Deploy Chain) to generate the config file.',
        );
        return;
      }

      // Read existing config
      const fileContent = await readFile(configPath, 'utf-8');
      const config = JSON.parse(fileContent);

      // Get the HTTP port to calculate WS port
      const httpPort = config?.http?.port || 8549;
      const wsPort = httpPort + 1;

      // Add WS configuration
      config.ws = {
        addr: '0.0.0.0',
        port: wsPort,
        api: ['eth', 'net', 'web3', 'arb', 'debug'],
      };

      // Write back to file
      await writeFile(configPath, JSON.stringify(config, null, 2));
      logger.success(`Successfully added WebSocket configuration to node-config.json (WS port: ${wsPort})`);
    } catch (error) {
      logger.errorWithFix(
        `Failed to add WS config: ${error instanceof Error ? error.message : String(error)}`,
        `Check that ${NODE_CONFIG_FILENAME} contains valid JSON.`,
      );
    }
  }

  /**
   * Add Feed Output configuration to node-config.json
   * This enables the main node to broadcast block updates via WebSocket feed,
   * which is required for honest validators to subscribe and stay synced.
   */
  private async addFeedOutputConfig(): Promise<void> {
    const DEFAULT_FEED_PORT = 9642;

    try {
      const configPath = path.join(process.cwd(), NODE_CONFIG_FILENAME);

      // Check if file exists
      if (!existsSync(configPath)) {
        logger.errorWithFix(
          `Node config file not found: ${configPath}`,
          'Deploy a chain first (Main Menu > Deploy Chain) to generate the config file.',
        );
        return;
      }

      // Read existing config
      const fileContent = await readFile(configPath, 'utf-8');
      const config = JSON.parse(fileContent);

      // Ensure node object exists
      if (!config.node || typeof config.node !== 'object') {
        config.node = {};
      }

      // Ensure feed object exists
      if (!config.node.feed || typeof config.node.feed !== 'object') {
        config.node.feed = {};
      }

      // Add feed output configuration
      config.node.feed.output = {
        enable: true,
        addr: '0.0.0.0',
        port: DEFAULT_FEED_PORT,
      };

      // Write back to file
      await writeFile(configPath, JSON.stringify(config, null, 2));
      logger.success(
        `Successfully added Feed Output configuration to node-config.json (Feed port: ${DEFAULT_FEED_PORT})`,
      );
      logger.info('Note: You need to restart the node for changes to take effect.');
      logger.info('Also ensure the Docker container exposes port 9642 (-p 9642:9642).');
    } catch (error) {
      logger.errorWithFix(
        `Failed to add Feed Output config: ${error instanceof Error ? error.message : String(error)}`,
        `Check that ${NODE_CONFIG_FILENAME} contains valid JSON.`,
      );
    }
  }
}

/**
 * Read node-config.json, apply overwrite function, and write back
 */
export async function overwriteNodeConfigFile(
  option: OverwriteOption,
  configPath: string = NODE_CONFIG_FILENAME,
): Promise<void> {
  // Check if file exists
  if (!existsSync(configPath)) {
    throw new Error(`Node config file not found: ${configPath}`);
  }

  // Read the existing config
  const fileContent = await readFile(configPath, 'utf-8');
  const nodeConfig: NodeConfig = JSON.parse(fileContent);

  // Apply the overwrite function
  const overwrittenConfig = applyOverwriteToNodeConfig(nodeConfig, option);

  // Write back to file
  await writeFile(configPath, JSON.stringify(overwrittenConfig, null, 2));
}

export const nodeConfigOperations = new NodeConfigOperations();
export default nodeConfigOperations;
