import chalk from 'chalk';
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
    // Console output only at LOG_LEVEL=debug; the file sink is gated by fileLogger itself.
    if ((process.env.LOG_LEVEL || '').toLowerCase() === 'debug') {
      console.debug(chalk.dim(message));
    }
    fileLogger.debug(message);
  },

  section: (message: string): void => {
    console.log();
    console.log(chalk.bold.cyan('▸ ' + message));
    console.log();
    fileLogger.info(`[SECTION] ${message}`);
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
};

export default logger;
