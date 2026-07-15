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

// inquirer v8's Ctrl+C handler closes its readline — the process's last live
// handle — and then re-raises SIGINT against itself. The signal callback needs
// an event-loop turn to run, but the loop is already empty, so the process
// exits 0 before any SIGINT listener fires. The only reliable place to say
// goodbye for that path is the synchronous 'exit' hook.
let farewellShown = false;
function farewell(message: string): void {
  if (!farewellShown) {
    farewellShown = true;
    console.log(`\n${message}`);
  }
}
process.on('exit', (code) => {
  if (code === 0) {
    farewell('Interrupted. Goodbye!');
  }
});

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
    farewellShown = true; // mainMenu prints its own farewell on normal exit
    process.exit(0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') {
      logger.newline();
      logger.info('Goodbye!');
      farewellShown = true;
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
    farewell('Interrupted. Goodbye!');
    process.exit(0);
  }
});

main();
