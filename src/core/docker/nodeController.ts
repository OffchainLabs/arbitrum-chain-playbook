/**
 * NodeController - Handles UI interactions for node management
 *
 * This controller separates UI logic (inquirer menus) from the business logic
 * in NodeManager. It delegates all actual node operations to NodeManager.
 */

import inquirer from 'inquirer';
import { NodeType, NodeAction, NodeManagerLike } from '../../types/index.js';
import { ChainEnv } from '../../state/chainEnv/index.js';
import logger from '../../utils/logger.js';
import { waitForEnter } from '../../utils/inquirerUtils.js';
import { breadcrumb } from '../../utils/breadcrumb.js';
import { requireChainInitiated } from '../../utils/guards.js';
import chalk from 'chalk';

/**
 * NodeController Class
 *
 * Provides interactive UI for node management operations.
 * Delegates all node operations to NodeManager.
 */
export class NodeController {
  private get chainEnv(): ChainEnv {
    return ChainEnv.getInstance();
  }

  private get nodeManager(): NodeManagerLike | null {
    return this.chainEnv.nodeManager;
  }

  /**
   * Show the interactive node management menu
   */
  async showManagementMenu(): Promise<void> {
    if (!requireChainInitiated()) {
      return;
    }

    const nodeManager = this.nodeManager;
    if (!nodeManager) {
      logger.errorWithFix(
        'NodeManager not available.',
        'Deploy a chain first (Main Menu > Deploy Chain) so that the node manager is initialized.',
      );
      return;
    }

    // Discover existing containers when entering node management
    await nodeManager.discoverExistingContainers();

    // Stop health monitoring to avoid spam during menu interaction
    const wasMonitoring = nodeManager.isMonitoringActive();
    nodeManager.stopHealthMonitoring();

    const chainId = this.chainEnv.chainConfig.getChainId();
    logger.info(`Managing nodes for Chain ID: ${chainId}`);

    breadcrumb.push('Manage Nodes');
    while (true) {
      breadcrumb.render();
      const { action } = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: 'Select action:',
          choices: [
            {
              name: `Start Main Node ${chalk.dim('— Sequencer, batch poster, and staker')}`,
              value: NodeAction.START_MAIN,
            },
            new inquirer.Separator(),
            { name: `View Node Details ${chalk.dim('— Inspect a running node')}`, value: 'node_details' },
            new inquirer.Separator(),
            { name: `Stop a Node ${chalk.dim('— Stop a specific running node')}`, value: NodeAction.STOP_NODE },
            { name: `Stop All Nodes ${chalk.dim('— Stop every running node')}`, value: NodeAction.STOP_ALL },
            new inquirer.Separator(),
            { name: '← Back to Main Menu', value: NodeAction.BACK },
          ],
        },
      ]);

      switch (action) {
        case NodeAction.START_MAIN:
          await nodeManager.startNode(NodeType.MAIN);
          break;
        case NodeAction.STOP_NODE:
          await this.selectAndStopNode();
          break;
        case NodeAction.STOP_ALL: {
          const running = nodeManager.getRunningNodes();
          if (running.length === 0) {
            logger.info('No running nodes to stop.');
            break;
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
          break;
        }
        case 'node_details':
          await this.showNodeDetails();
          break;
        case NodeAction.BACK:
          breadcrumb.pop();
          // Restart monitoring when exiting if nodes are running and monitoring was active
          if (nodeManager.getRunningNodes().length > 0 && wasMonitoring) {
            await nodeManager.startHealthMonitoring();
          }
          return;
      }
      logger.newline();
    }
  }

  /**
   * Select and stop a node interactively
   */
  async selectAndStopNode(): Promise<void> {
    const nodeManager = this.nodeManager;
    if (!nodeManager) return;

    const runningNodes = nodeManager.getRunningNodes();
    if (runningNodes.length === 0) {
      logger.errorWithFix(
        'No running nodes available to stop.',
        'Start a node first via Manage Nodes > Start Main Node.',
      );
      return;
    }

    const choices = runningNodes.map((n) => ({ name: n.config.id, value: n.config.id }));
    choices.push({ name: '← Back to Node Management', value: 'back' });

    const { selectedId } = await inquirer.prompt([
      { type: 'list', name: 'selectedId', message: 'Select a node to stop:', choices },
    ]);

    if (selectedId === 'back') {
      return;
    }

    const { confirmStop } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmStop',
        message: `Stop node "${selectedId}"? This will terminate its Docker container.`,
        default: false,
      },
    ]);

    if (confirmStop) {
      await nodeManager.stopNode(selectedId);
    }
  }

  /**
   * Show detailed node information
   */
  async showNodeDetails(): Promise<void> {
    const nodeManager = this.nodeManager;
    if (!nodeManager) return;

    const runningNodes = nodeManager.getRunningNodes();
    if (runningNodes.length === 0) {
      logger.info('No nodes running.');
      return;
    }

    const choices = runningNodes.map((node) => ({
      name: `${node.config.id} (${node.status}) - HTTP ${node.config.httpPort}`,
      value: node.config.id,
    }));
    choices.push({ name: '← Back', value: 'back' });

    const { selectedNode } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedNode',
        message: 'Select a node to view details:',
        choices,
      },
    ]);

    if (selectedNode === 'back') return;

    const node = nodeManager.getNode(selectedNode);
    if (!node) return;

    logger.section(`Node Details: ${selectedNode}`);
    logger.raw(`  Node ID:      ${selectedNode}`);
    logger.raw(`  Type:         ${node.config.nodeType}`);
    logger.raw(`  Status:       ${node.status}`);
    logger.raw(`  HTTP Port:    ${node.config.httpPort}`);
    logger.raw(`  WS Port:      ${node.config.wsPort}`);
    logger.raw(`  Container ID: ${node.containerId || 'Not available'}`);
    logger.raw(`  HTTP Endpoint: http://localhost:${node.config.httpPort}`);

    const isHealthy = await nodeManager.checkNodeHealth(selectedNode);
    const uptime = await nodeManager.getNodeUptime(selectedNode);
    logger.raw(`  Health:       ${isHealthy ? '🟢 Healthy' : '🔴 Unhealthy'}`);
    logger.raw(`  Uptime:       ${uptime}`);

    await waitForEnter('Press Enter to continue...');
  }
}

// Singleton instance for convenience
export const nodeController = new NodeController();

export default nodeController;
