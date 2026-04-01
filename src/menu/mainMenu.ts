import inquirer from 'inquirer';
import { MenuAction, OperationMode } from '../types/index.js';
import { deployChain } from '../core/deployChain/deployChain.js';
import logger from '../utils/logger.js';
import { withCancellation } from '../utils/cancellation.js';
import { getParentChain } from '../utils/parentChain.js';
import { nodeConfigOperations } from '../core/nodeConfig/nodeConfigOperations.js';
import { manageChainOperations } from '../core/manageChain/manageChainOperations.js';
import { interactChainOperations } from '../core/interactChain/interactChainOperations.js';
import { playbookRegistry } from '../playbooks/index.js';
import { ChainEnv } from '../state/chainEnv/index.js';
import { SendersEnv } from '../state/sendersEnv/index.js';
import { NodeManager } from '../core/docker/nodeManager.js';
import { breadcrumb } from '../utils/breadcrumb.js';
import { DevnodeManager, DEVNODE_CONFIG, enterDevnodeMode } from '../devnode/index.js';
import { enterRemoteRpcMode, getRemoteRpcConfig } from '../remoteRpc/index.js';
import { initializeChainMode } from '../init.js';
import { nodeController } from '../core/docker/nodeController.js';
import { guard } from '../utils/guards.js';
import { renderInfoTable, renderNodeTable, renderAccountsTable, buildNodeRow } from '../utils/statusDisplay.js';
import chalk from 'chalk';

import { setNodeManagerClass } from '../state/chainEnv/index.js';
setNodeManagerClass(NodeManager);

export class MainMenu {
  private isRunning: boolean = true;

  private get chainEnv(): ChainEnv {
    return ChainEnv.getInstance();
  }

  private get sendersEnv(): SendersEnv {
    return SendersEnv.getInstance();
  }

  async show(): Promise<void> {
    while (this.isRunning) {
      if (this.chainEnv.operationMode === OperationMode.NONE) {
        breadcrumb.render();
        const continueToMainMenu = await this.selectOperationMode();
        if (!continueToMainMenu) {
          return;
        }
      }

      const isInitated = this.chainEnv.status.isInitiated();
      const chainId = this.chainEnv.chainConfig.getChainId();

      breadcrumb.render();
      const { action } = await inquirer.prompt([
        {
          type: 'list',
          name: 'action',
          message: 'Select an action:',
          choices: this.getMenuChoices(isInitated, chainId),
        },
      ]);

      await this.handleAction(action);
    }
  }

  private async selectOperationMode(): Promise<boolean> {
    const { mode } = await inquirer.prompt([
      {
        type: 'list',
        name: 'mode',
        message: 'Select mode:',
        choices: [
          {
            name: this.chainEnv.isChainModeAvailable()
              ? `Start Chain Mode ${chalk.dim('— Deploy and manage Orbit chains on a parent chain')}`
              : 'Start Chain Mode [PARENT_CHAIN_RPC not set]',
            value: OperationMode.CHAIN,
            disabled: !this.chainEnv.isChainModeAvailable(),
          },
          {
            name: `Start Devnode Mode ${chalk.dim('— Run a local Nitro devnode for development')}`,
            value: OperationMode.DEVNODE,
          },
          {
            name: this.chainEnv.isRemoteRpcModeAvailable()
              ? `Start Remote RPC Mode ${chalk.dim('— Connect to an existing chain via RPC')}`
              : 'Start Remote RPC Mode [Required env vars not set]',
            value: OperationMode.REMOTE_RPC,
            disabled: !this.chainEnv.isRemoteRpcModeAvailable(),
          },
          new inquirer.Separator(),
          { name: 'Exit', value: MenuAction.EXIT },
        ],
      },
    ]);

    if (mode === MenuAction.EXIT) {
      return false;
    }

    if (mode === OperationMode.DEVNODE) {
      await enterDevnodeMode();
      return true;
    }

    if (mode === OperationMode.CHAIN) {
      this.chainEnv.setOperationMode(OperationMode.CHAIN);
      setNodeManagerClass(NodeManager);
      await initializeChainMode();
      return true;
    }

    if (mode === OperationMode.REMOTE_RPC) {
      const success = await enterRemoteRpcMode();
      if (!success) {
        // User cancelled or error occurred, go back to mode selection
        return true;
      }
      return true;
    }

    return false;
  }

  private getMenuChoices(isInitated: boolean, chainId: number | null) {
    if (this.chainEnv.operationMode === OperationMode.DEVNODE) {
      return [
        { name: 'Manage Nodes', value: MenuAction.MANAGE_NODES },
        { name: 'View Status', value: MenuAction.VIEW_STATUS },
        { name: 'Playbook List', value: MenuAction.PLAYBOOK_LIST },
        new inquirer.Separator(),
        { name: 'Exit', value: MenuAction.EXIT },
      ];
    }

    if (this.chainEnv.operationMode === OperationMode.REMOTE_RPC) {
      return [
        { name: 'Interact with Chain', value: MenuAction.INTERACT_CHAIN },
        { name: 'View Status', value: MenuAction.VIEW_STATUS },
        { name: 'Playbook List', value: MenuAction.PLAYBOOK_LIST },
        new inquirer.Separator(),
        { name: 'Exit', value: MenuAction.EXIT },
      ];
    }

    return [
      {
        name: isInitated
          ? `Deploy New Chain (will replace Chain ${chainId}) ${chalk.dim('— Create a new Orbit chain')}`
          : `Deploy New Chain ${chalk.dim('— Create and deploy a new Orbit chain')}`,
        value: MenuAction.DEPLOY_CHAIN,
      },
      { name: `Manage Nodes ${chalk.dim('— Start, stop, and monitor Docker nodes')}`, value: MenuAction.MANAGE_NODES },
      { name: `Manage the Chain ${chalk.dim('— Configure TPS and chain parameters')}`, value: MenuAction.MANAGE_CHAIN },
      {
        name: `Interact with Chain ${chalk.dim('— Deposit ETH and interact with contracts')}`,
        value: MenuAction.INTERACT_CHAIN,
      },
      { name: `View Status ${chalk.dim('— Show chain, node, and account info')}`, value: MenuAction.VIEW_STATUS },
      {
        name: `Node Config Operations ${chalk.dim('— Modify node-config.json settings')}`,
        value: MenuAction.NODECONFIG_OPERATIONS,
      },
      { name: `Playbook List ${chalk.dim('— Run demos and stress tests')}`, value: MenuAction.PLAYBOOK_LIST },
      new inquirer.Separator(),
      { name: 'Exit', value: MenuAction.EXIT },
    ];
  }

  private async handleAction(action: MenuAction): Promise<void> {
    switch (action) {
      case MenuAction.DEPLOY_CHAIN:
        await this.handleDeployChain();
        break;

      case MenuAction.MANAGE_NODES:
        await this.handleManageNodes();
        break;

      case MenuAction.MANAGE_CHAIN:
        await this.handleManageChain();
        break;

      case MenuAction.INTERACT_CHAIN:
        await this.handleInteractChain();
        break;

      case MenuAction.VIEW_STATUS:
        await this.handleViewStatus();
        break;

      case MenuAction.NODECONFIG_OPERATIONS:
        await this.handleNodeConfigOperations();
        break;

      case MenuAction.PLAYBOOK_LIST:
        await this.handlePlaybookList();
        break;

      case MenuAction.EXIT:
        await this.handleExit();
        break;
    }
  }

  private async handleDeployChain(): Promise<void> {
    if (this.chainEnv.status.isInitiated()) {
      const chainId = this.chainEnv.chainConfig.getChainId();
      const { confirmDeploy } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirmDeploy',
          message: `Chain ${chainId} already exists. Deploy a new chain and replace the existing configuration?`,
          default: false,
        },
      ]);

      if (!confirmDeploy) {
        logger.info('Chain deployment cancelled.');
        return;
      }

      logger.info('Deploying new chain will replace existing configuration...');
    }

    const parentChain = getParentChain();

    await withCancellation('Chain Deployment', (ctx) => deployChain(parentChain, ctx));
  }

  private async handleManageNodes(): Promise<void> {
    await nodeController.showManagementMenu();
  }

  private async handleManageChain(): Promise<void> {
    if (!guard.requireChainInitiated()) {
      logger.newline();
      return;
    }

    await manageChainOperations.showMenu();
  }

  private async handleInteractChain(): Promise<void> {
    await interactChainOperations.showMenu();
  }

  private async handleViewStatus(): Promise<void> {
    if (this.chainEnv.operationMode === OperationMode.DEVNODE) {
      await this.renderDevnodeStatus();
      return;
    }

    if (this.chainEnv.operationMode === OperationMode.REMOTE_RPC) {
      await this.renderRemoteRpcStatus();
      return;
    }

    if (this.chainEnv.status.isInitiated()) {
      const status = this.chainEnv.status.get();
      const coreContracts = this.chainEnv.chainConfig.getCoreContracts();
      const rows: Array<{ label: string; value: string }> = [
        { label: 'Chain ID', value: String(this.chainEnv.chainConfig.getChainId()) },
        { label: 'Status', value: status },
      ];
      if (coreContracts) {
        rows.push({ label: 'Rollup', value: coreContracts.rollup });
        rows.push({ label: 'Inbox', value: coreContracts.inbox });
      }
      renderInfoTable('Chain Information', rows);
    } else {
      logger.warn('No chain deployed yet.');
    }

    const nodeManager = this.chainEnv.nodeManager;
    if (nodeManager) {
      await nodeManager.discoverExistingContainers();
      const nodeRows = await this.buildNodeRows(nodeManager);
      renderNodeTable(nodeRows);
    } else {
      renderNodeTable([]);
    }

    this.renderAccounts();
    logger.newline();
  }

  private async handleNodeConfigOperations(): Promise<void> {
    await nodeConfigOperations.showMenu();
  }

  private async handlePlaybookList(): Promise<void> {
    await playbookRegistry.showPlaybookList();
  }

  private async handleExit(): Promise<void> {
    const nodeManager = this.chainEnv.nodeManager;
    const runningNodes = nodeManager ? nodeManager.getRunningNodes() : [];

    if (runningNodes.length > 0 && nodeManager) {
      const { exitChoice } = await inquirer.prompt([
        {
          type: 'list',
          name: 'exitChoice',
          message: `${runningNodes.length} node(s) are still running. What would you like to do?`,
          choices: [
            { name: 'Stop nodes and exit', value: 'stop_and_exit' },
            { name: 'Exit without stopping nodes', value: 'exit_only' },
            { name: 'Cancel (back to menu)', value: 'cancel' },
          ],
        },
      ]);

      if (exitChoice === 'cancel') {
        return; // Don't exit
      }

      if (exitChoice === 'stop_and_exit') {
        await nodeManager.stopAllNodes();
      }
    }

    logger.newline();
    logger.success('Thank you for using Arbitrum Chain Playbook!');
    logger.newline();

    this.isRunning = false;
  }

  private async renderDevnodeStatus(): Promise<void> {
    const devnodeManager = new DevnodeManager();
    const status = await devnodeManager.getStatus();

    const rows: Array<{ label: string; value: string }> = [
      { label: 'Status', value: status.running ? 'running' : 'stopped' },
      { label: 'RPC URL', value: DEVNODE_CONFIG.rpcUrl },
      { label: 'WS URL', value: DEVNODE_CONFIG.wsUrl },
      { label: 'Chain ID', value: String(status.chainId ?? DEVNODE_CONFIG.chainId) },
      { label: 'Dev Account', value: DEVNODE_CONFIG.devAccount },
    ];
    if (status.balanceWei !== undefined) {
      rows.push({ label: 'Balance', value: `${status.balanceWei} wei` });
    }
    if (status.blockHeight !== undefined) {
      rows.push({ label: 'Block Height', value: String(status.blockHeight) });
    }
    renderInfoTable('Devnode Information', rows);

    const nodeManager = this.chainEnv.nodeManager;
    if (nodeManager) {
      await nodeManager.discoverExistingContainers();
      const nodeRows = await this.buildNodeRows(nodeManager);
      renderNodeTable(nodeRows);
    } else {
      renderNodeTable([]);
    }

    this.renderAccounts();
    logger.newline();
  }

  private async renderRemoteRpcStatus(): Promise<void> {
    const remoteConfig = getRemoteRpcConfig();

    const rows: Array<{ label: string; value: string }> = [
      { label: 'Mode', value: 'Remote RPC' },
      { label: 'Chain ID', value: String(this.chainEnv.chainConfig.getChainId()) },
      { label: 'Chain RPC', value: this.chainEnv.remoteRpcUrl ?? '' },
    ];
    if (remoteConfig) {
      rows.push({ label: 'Parent RPC', value: remoteConfig.parentChainRpc });
      rows.push({ label: 'Deploy TX', value: remoteConfig.deploymentTxHash });
    }
    const coreContracts = this.chainEnv.chainConfig.getCoreContracts();
    if (coreContracts) {
      rows.push({ label: 'Rollup', value: coreContracts.rollup });
      rows.push({ label: 'Inbox', value: coreContracts.inbox });
    }
    renderInfoTable('Remote RPC Information', rows);

    this.renderAccounts();
    logger.newline();
  }

  private async buildNodeRows(nodeManager: import('../types/index.js').NodeManagerLike) {
    const rows: Parameters<typeof renderNodeTable>[0] = [];
    const nodes = nodeManager.getRunningNodes();
    // Also include non-running tracked nodes if the manager exposes them
    const allNodes = (nodeManager as any).getNodes?.() as
      | Map<string, import('../types/index.js').NodeInstance>
      | undefined;
    const entries = allNodes ? Array.from(allNodes.entries()) : nodes.map((n) => [n.config.id, n] as const);

    for (const [id, node] of entries) {
      let uptime: string | undefined;
      if (nodeManager.getNodeUptime) {
        try {
          uptime = await nodeManager.getNodeUptime(id as string);
        } catch {}
      }
      rows.push(buildNodeRow(id as string, node as import('../types/index.js').NodeInstance, uptime));
    }
    return rows;
  }

  private renderAccounts(): void {
    const senders = this.sendersEnv.getAll();
    renderAccountsTable(senders.map((a) => ({ role: a.role, address: a.signer.address })));
  }
}

export const mainMenu = new MainMenu();
export default mainMenu;
