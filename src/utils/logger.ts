import chalk from 'chalk';
import { debug } from 'console';
import ora, { type Ora } from 'ora';
import { fileLogger } from './fileLogger.js';

export const logger = {
  info: (message: string): void => {
    console.log(chalk.blue('ℹ'), chalk.blue(message));
    fileLogger.info(message);
  },

  success: (message: string): void => {
    console.log(chalk.green('✔'), chalk.green(message));
    fileLogger.info(`[SUCCESS] ${message}`);
  },

  warn: (message: string): void => {
    console.log(chalk.yellow('⚠'), chalk.yellow(message));
    fileLogger.warn(message);
  },

  error: (message: string): void => {
    console.log(chalk.red('✖'), chalk.red(message));
    fileLogger.error(message, new Error(message).stack);
  },

  debug: (message: string): void => {
    debug(message);
    fileLogger.debug(message);
  },

  step: (step: number, total: number, message: string): void => {
    console.log(chalk.cyan(`[${step}/${total}]`), message);
    fileLogger.info(`[${step}/${total}] ${message}`);
  },

  title: (message: string): void => {
    console.log();
    console.log(chalk.bold.magenta('🎮 ' + message));
    console.log(chalk.magenta('='.repeat(message.length + 3)));
    console.log();
    fileLogger.info(`[TITLE] ${message}`);
  },

  section: (message: string): void => {
    console.log();
    console.log(chalk.bold.cyan('▸ ' + message));
    console.log();
    fileLogger.info(`[SECTION] ${message}`);
  },

  divider: (): void => {
    console.log(chalk.gray('─'.repeat(50)));
  },

  nodeStatus: (nodeName: string, status: string, type: string): void => {
    const typeColor = type === 'honest' ? chalk.green : chalk.red;
    const statusColor =
      status === 'running'
        ? chalk.green
        : status === 'stopped'
          ? chalk.gray
          : status === 'starting'
            ? chalk.yellow
            : chalk.red;

    console.log(`  ${typeColor('●')} ${chalk.bold(nodeName)} - ${statusColor(status)} (${typeColor(type)})`);
    fileLogger.info(`[NODE] ${nodeName}: ${status} (${type})`);
  },

  errorWithFix: (message: string, fix: string): void => {
    console.log(chalk.red('✖'), chalk.red(message));
    console.log(chalk.white(`  How to fix: ${fix}`));
    fileLogger.error(`${message} | Fix: ${fix}`, new Error(message).stack);
  },

  txHash: (hash: string, method?: string, status?: string): void => {
    const parts = [chalk.dim('TX:'), chalk.white(hash)];
    if (method) parts.push(chalk.dim('|'), chalk.cyan(method));
    if (status) {
      const statusColor = status === 'success' ? chalk.green : status === 'reverted' ? chalk.red : chalk.yellow;
      parts.push(chalk.dim('|'), statusColor(status));
    }
    console.log(`  ${parts.join(' ')}`);

    const logParts = [`TX: ${hash}`];
    if (method) logParts.push(`| ${method}`);
    if (status) logParts.push(`| ${status}`);
    fileLogger.info(logParts.join(' '));
  },

  event: (message: string): void => {
    console.log(chalk.bold.magenta('⚡'), chalk.bold.white(message));
    fileLogger.info(`[EVENT] ${message}`);
  },

  nodeHealth: (nodeName: string, opts: { uptime?: string; blocksProcessed?: number | bigint }): void => {
    const parts = [`Node ${chalk.bold(nodeName)} healthy ${chalk.green('✓')}`];
    const details: string[] = [];
    if (opts.uptime) details.push(`uptime: ${opts.uptime}`);
    if (opts.blocksProcessed !== undefined) details.push(`blocks processed: ${opts.blocksProcessed}`);
    if (details.length > 0) parts.push(chalk.dim(`(${details.join(', ')})`));
    console.log(`  ${chalk.green('✔')} ${parts.join(' ')}`);

    const logDetails = [];
    if (opts.uptime) logDetails.push(`uptime: ${opts.uptime}`);
    if (opts.blocksProcessed !== undefined) logDetails.push(`blocks: ${opts.blocksProcessed}`);
    fileLogger.info(`[HEALTH] ${nodeName}: healthy (${logDetails.join(', ')})`);
  },

  raw: (message: string): void => {
    console.log(message);
    fileLogger.raw(message);
  },

  newline: (): void => {
    console.log();
  },

  progress: (current: number, total: number, message: string): void => {
    const percentage = Math.round((current / total) * 100);
    const progressBar = '█'.repeat(Math.floor(percentage / 5)) + '░'.repeat(20 - Math.floor(percentage / 5));
    process.stdout.write(`\r${chalk.cyan('⏳')} [${progressBar}] ${percentage}% ${message}`);
    if (current === total) console.log();
  },

  spinner: (() => {
    let instance: Ora | null = null;
    return {
      start: (message: string) => {
        if (instance) instance.stop();
        instance = ora({ text: message, spinner: 'dots' }).start();
        fileLogger.info(`[SPINNER] ${message}`);
      },
      stop: (success: boolean = true) => {
        if (instance) {
          if (success) {
            instance.succeed();
          } else {
            instance.fail();
          }
          instance = null;
        }
      },
    };
  })(),
};

export default logger;
