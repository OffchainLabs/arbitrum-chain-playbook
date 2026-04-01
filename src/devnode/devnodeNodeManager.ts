import inquirer from 'inquirer';
import { NodeInstance, NodeType } from '../types/index.js';
import logger from '../utils/logger.js';
import { breadcrumb } from '../utils/breadcrumb.js';
import chalk from 'chalk';
import { DevnodeManager } from './devnodeManager.js';
import { DEVNODE_CONFIG } from './devnodeConfig.js';
import { renderNodeTable, buildNodeRow } from '../utils/statusDisplay.js';

enum DevnodeAction {
  START = 'start',
  STOP = 'stop',
  RESTART = 'restart',
  BACK = 'back',
}

export class DevnodeNodeManager {
  private devnodeManager = new DevnodeManager();
  private cachedNode: NodeInstance | null = null;

  constructor(_chainEnv: unknown) {
    void _chainEnv;
  }

  async manageNodes(): Promise<void> {
    breadcrumb.push('Devnode');
    while (true) {
      breadcrumb.render();
      const { action } = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: 'Select action:',
          choices: [
            { name: `Start Devnode ${chalk.dim('— Launch a local Nitro devnode')}`, value: DevnodeAction.START },
            { name: `Stop Devnode ${chalk.dim('— Terminate the running devnode')}`, value: DevnodeAction.STOP },
            { name: `Restart Devnode ${chalk.dim('— Stop and restart the devnode')}`, value: DevnodeAction.RESTART },
            new inquirer.Separator(),
            { name: '← Back to Main Menu', value: DevnodeAction.BACK },
          ],
        },
      ]);

      switch (action) {
        case DevnodeAction.START:
          await this.devnodeManager.startDevnode();
          break;
        case DevnodeAction.STOP: {
          const { confirmStop } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'confirmStop',
              message: 'Stop the devnode? This will terminate the Docker container.',
              default: false,
            },
          ]);
          if (confirmStop) {
            await this.devnodeManager.stopDevnode();
          }
          break;
        }
        case DevnodeAction.RESTART:
          await this.devnodeManager.restartDevnode();
          break;
        case DevnodeAction.BACK:
          breadcrumb.pop();
          return;
      }
      logger.newline();
    }
  }

  async discoverExistingContainers(): Promise<void> {
    this.cachedNode = await this.devnodeManager.getDevnodeNodeInstance();
  }

  getRunningNodes(): NodeInstance[] {
    if (this.cachedNode) return [this.cachedNode];
    return [];
  }

  getNode(nodeId: string): NodeInstance | undefined {
    if (!this.cachedNode) return undefined;
    return this.cachedNode.config.id === nodeId ? this.cachedNode : undefined;
  }

  displayStatus(): void {
    if (!this.cachedNode) {
      renderNodeTable([]);
      return;
    }
    renderNodeTable([buildNodeRow(this.cachedNode.config.id, this.cachedNode)]);
  }

  async stopNode(nodeId: string): Promise<boolean> {
    if (!this.cachedNode || this.cachedNode.config.id !== nodeId) {
      return false;
    }
    await this.devnodeManager.stopDevnode();
    this.cachedNode = null;
    return true;
  }

  async stopAllNodes(): Promise<void> {
    await this.devnodeManager.stopDevnode();
    this.cachedNode = null;
  }

  async startNode(_type: NodeType): Promise<NodeInstance | null> {
    await this.devnodeManager.startDevnode();
    await this.discoverExistingContainers();
    return this.cachedNode;
  }
}
