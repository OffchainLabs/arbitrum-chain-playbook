/**
 * Timeboost Playbook entry point.
 *
 * This Playbook demonstrates Arbitrum's Timeboost express-lane auction policy:
 * sealed-bid second-price auctions, round transitions, and the 200ms
 * non-express-lane delay. Designed as a lab demo (not production).
 *
 * The orchestration lives in `timeboostDemoRunner.ts`; this file is the
 * inquirer-shaped façade.
 */

import inquirer from 'inquirer';
import chalk from 'chalk';
import { Playbook, HeadlessCommandSpec, PlaybookActionResult } from '../types.js';
import { OperationMode } from '../../types/index.js';
import logger from '../../utils/logger.js';
import { breadcrumb } from '../../utils/breadcrumb.js';
import { withCancellation, type OperationContext } from '../../utils/cancellation.js';
import { runFullTimeboostDemo, viewTimeboostStatus, stopTimeboostStack } from './timeboostDemoRunner.js';

enum TimeboostAction {
  RUN_FULL_DEMO = 'run_full_demo',
  VIEW_STATUS = 'view_status',
  STOP_STACK = 'stop_stack',
  BACK = 'back',
}

class TimeboostPlaybook implements Playbook {
  id = 'timeboost';
  name = 'Timeboost Auction Lifecycle';
  description = 'Sealed-bid second-price auction, express-lane controller, 200ms delay (lab demo)';
  supportedModes = [OperationMode.CHAIN];

  async showMenu(): Promise<void> {
    breadcrumb.push('Timeboost');
    logger.raw(chalk.dim('Lab demo for Arbitrum Timeboost. Public Preview / Alpha — not production.'));
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
              name: `Run Full Timeboost Demo ${chalk.dim('— Deploy, bid, race, report')}`,
              value: TimeboostAction.RUN_FULL_DEMO,
            },
            new inquirer.Separator(),
            {
              name: `View Timeboost Status ${chalk.dim('— Round, controller, services')}`,
              value: TimeboostAction.VIEW_STATUS,
            },
            {
              name: `Stop Timeboost Services ${chalk.dim('— Tear down Redis + auctioneer')}`,
              value: TimeboostAction.STOP_STACK,
            },
            new inquirer.Separator(),
            { name: '← Back to Playbook List', value: TimeboostAction.BACK },
          ],
        },
      ]);

      switch (action) {
        case TimeboostAction.RUN_FULL_DEMO:
          await this.handleRunFullDemo();
          break;
        case TimeboostAction.VIEW_STATUS:
          await viewTimeboostStatus();
          break;
        case TimeboostAction.STOP_STACK:
          await this.handleStopStack();
          break;
        case TimeboostAction.BACK:
          breadcrumb.pop();
          return;
      }

      logger.newline();
    }
  }

  private async handleRunFullDemo(): Promise<void> {
    logger.section('Run Full Timeboost Demo');
    logger.raw('This demo will:');
    logger.raw('  1. Deploy a fresh Orbit chain');
    logger.raw('  2. Deploy ExpressLaneAuction (proxy) + ProxyAdmin + bidding ERC20');
    logger.raw('  3. Start Redis, bid-validator, auctioneer-server containers');
    logger.raw('  4. Patch sequencer config for Timeboost + restart');
    logger.raw('  5. Run a multi-round auction with 2 bidders + 1 controller');
    logger.raw('  6. Race express-lane vs normal txs and capture receipts');
    logger.raw('  7. Demonstrate NOT_EXPRESS_LANE_CONTROLLER rejection');
    logger.raw('  8. Generate an HTML report under logs/');
    logger.newline();
    logger.warn('This will redeploy your chain (existing chain data will be deleted).');
    logger.newline();

    const { confirm } = await inquirer.prompt([
      { type: 'confirm', name: 'confirm', message: 'Continue?', default: true },
    ]);
    if (!confirm) {
      logger.info('Demo cancelled.');
      return;
    }

    try {
      await withCancellation('Timeboost Demo', (ctx) => runFullTimeboostDemo(ctx));
    } catch (e) {
      logger.errorWithFix(
        `Demo failed: ${e instanceof Error ? e.message : String(e)}`,
        'Check Docker, sequencer logs (`docker logs <container>`), and PARENT_CHAIN_RPC connectivity.',
      );
    }
  }

  private async handleStopStack(): Promise<void> {
    const { confirm } = await inquirer.prompt([
      { type: 'confirm', name: 'confirm', message: 'Stop all Timeboost services?', default: false },
    ]);
    if (!confirm) return;
    await stopTimeboostStack();
  }

  // -------------------------------------------------------------------------
  // Headless interface (mirrors malicious-validator)
  // -------------------------------------------------------------------------

  listHeadlessCommands(): HeadlessCommandSpec[] {
    return [
      {
        command: 'run-full-demo',
        description: 'Deploy + bid + race + report, all unattended.',
        supportedModes: [OperationMode.CHAIN],
        redeploysChain: true,
      },
    ];
  }

  async runHeadless(command: string, _params: unknown, ctx?: OperationContext): Promise<PlaybookActionResult> {
    if (command !== 'run-full-demo') {
      return { success: false, message: `Unknown command: ${command}` };
    }
    try {
      const result = await runFullTimeboostDemo(ctx);
      return { success: true, message: 'Demo finished', data: result };
    } catch (e) {
      return { success: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
}

export const timeboostPlaybook = new TimeboostPlaybook();
export default timeboostPlaybook;
