#!/usr/bin/env node

import inquirer from 'inquirer';
import { mainMenu } from './menu/mainMenu.js';
import logger from './utils/logger.js';
import { config } from 'dotenv';
import { initializeApp } from './init.js';
import { cancellationManager } from './utils/cancellation.js';
import { showStartupDashboard } from './utils/dashboard.js';
import { initFileLogger, getLogFilePath } from './utils/fileLogger.js';
import { drainStdin } from './utils/breadcrumb.js';

config();

// Patch inquirer.prompt to auto-flush buffered stdin before every prompt.
const _originalPrompt = inquirer.prompt.bind(inquirer);
inquirer.prompt = (async (questions: any, answers?: any) => {
  await drainStdin();
  return _originalPrompt(questions, answers);
}) as typeof inquirer.prompt;

async function main(): Promise<void> {
  try {
    console.clear();
    initFileLogger();

    initializeApp();
    await showStartupDashboard();

    const logFile = getLogFilePath();
    if (logFile) {
      logger.info(`Session log: ${logFile}`);
    }
    await mainMenu.show();
    process.exit(0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') {
      logger.newline();
      logger.info('Goodbye!');
      process.exit(0);
    }

    logger.errorWithFix(
      `An unexpected error occurred: ${(error as Error).message}`,
      'Check .env configuration and ensure Docker is running. Re-run the app to try again.',
    );
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  const handled = cancellationManager.handleSigint();
  if (!handled) {
    logger.newline();
    logger.info('Interrupted. Goodbye!');
    process.exit(0);
  }
});

main();
