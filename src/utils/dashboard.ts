/**
 * Startup dashboard — welcome banner + pre-flight environment checks.
 * Exits with code 1 if a blocker is found (e.g. Docker not running).
 */

import { execSync } from 'child_process';
import chalk from 'chalk';
import { config } from '../config/index.js';
import { ChainEnv } from '../state/chainEnv/index.js';
import { APP_NAME } from '../types/constants.js';

type CheckStatus = 'pass' | 'warn' | 'fail' | 'info';

interface CheckResult {
  label: string;
  status: CheckStatus;
  detail: string;
  blocker: boolean;
  fixInstruction?: string;
}

function isDockerRunning(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function runPreflightChecks(): CheckResult[] {
  const checks: CheckResult[] = [];
  const chainEnv = ChainEnv.getInstance();

  const dockerOk = isDockerRunning();
  checks.push({
    label: 'Docker daemon',
    status: dockerOk ? 'pass' : 'fail',
    detail: dockerOk ? 'running' : 'not found',
    blocker: !dockerOk,
    fixInstruction: dockerOk ? undefined : 'Run `docker desktop start` (macOS) or `systemctl start docker` (Linux)',
  });

  const parentChainName = config.app.parentChainDisplayName;
  const isDefault = config.app.isDefaultParentChain;
  checks.push({
    label: 'Parent chain',
    status: isDefault ? 'pass' : 'warn',
    detail: isDefault ? parentChainName : `${parentChainName} (non-default)`,
    blocker: false,
  });

  const hasParentRpc = !!config.app.parentChainRpc;
  checks.push({
    label: 'PARENT_CHAIN_RPC',
    status: hasParentRpc ? 'pass' : 'warn',
    detail: hasParentRpc ? 'configured' : 'not set (Chain mode unavailable)',
    blocker: false,
  });

  const hasKey = config.hasDeployerKey();
  checks.push({
    label: 'MAIN_PRIVATE_KEY',
    status: hasKey ? 'pass' : 'warn',
    detail: hasKey ? 'configured' : 'not set (deploy/demos unavailable)',
    blocker: false,
  });

  const hasTxHash = !!config.app.deploymentTxHash;
  checks.push({
    label: 'Chain deployment',
    status: hasTxHash ? 'pass' : 'info',
    detail: hasTxHash ? 'tx hash configured' : 'not detected',
    blocker: false,
  });

  const hasChainRpc = !!config.app.chainRpc;
  checks.push({
    label: 'CHAIN_RPC',
    status: hasChainRpc ? 'pass' : 'info',
    detail: hasChainRpc ? 'configured' : 'not set (needed for Remote RPC mode)',
    blocker: false,
  });

  const isInitiated = chainEnv.status.isInitiated();
  checks.push({
    label: 'Chain state',
    status: isInitiated ? 'pass' : 'info',
    detail: isInitiated ? 'loaded' : 'not initiated',
    blocker: false,
  });

  if (isInitiated) {
    const nodeManager = chainEnv.nodeManager;
    const runningCount = nodeManager ? nodeManager.getRunningNodes().length : 0;
    checks.push({
      label: 'Running nodes',
      status: runningCount > 0 ? 'pass' : 'info',
      detail: runningCount > 0 ? `${runningCount} running` : 'none',
      blocker: false,
    });
  } else {
    checks.push({
      label: 'Running nodes',
      status: 'info',
      detail: 'none',
      blocker: false,
    });
  }

  return checks;
}

const STATUS_ICONS: Record<CheckStatus, string> = {
  pass: chalk.green('✔'),
  warn: chalk.yellow('⚠'),
  fail: chalk.red('✖'),
  info: chalk.blue('ℹ'),
};

function renderBanner(): void {
  console.log();
  console.log(chalk.bold.magenta(`🎮 ${APP_NAME}`));
  console.log(chalk.magenta('═'.repeat(APP_NAME.length + 3)));
  console.log();
}

function renderChecks(checks: CheckResult[]): void {
  const LABEL_WIDTH = 34;

  console.log(chalk.bold('  Pre-flight Checks'));
  console.log(chalk.dim('  ' + '─'.repeat(LABEL_WIDTH + 20)));

  for (const check of checks) {
    const icon = STATUS_ICONS[check.status];
    const paddedLabel = check.label.padEnd(LABEL_WIDTH - 4);

    let coloredDetail: string;
    switch (check.status) {
      case 'pass':
        coloredDetail = chalk.green(check.detail);
        break;
      case 'warn':
        coloredDetail = chalk.yellow(check.detail);
        break;
      case 'fail':
        coloredDetail = chalk.red(check.detail);
        break;
      default:
        coloredDetail = chalk.dim(check.detail);
    }

    console.log(`  ${icon} ${paddedLabel}${coloredDetail}`);
  }

  console.log();

  const blockers = checks.filter((c) => c.blocker);
  if (blockers.length > 0) {
    for (const blocker of blockers) {
      console.log(chalk.red.bold(`  ${blocker.label} is required but not available.`));
      if (blocker.fixInstruction) {
        console.log(chalk.white(`  How to fix: ${blocker.fixInstruction}`));
      }
      console.log();
    }
  }
}

export async function showStartupDashboard(): Promise<void> {
  renderBanner();
  const checks = runPreflightChecks();
  renderChecks(checks);

  const hasBlocker = checks.some((c) => c.blocker);
  if (hasBlocker) {
    process.exit(1);
  }
}
