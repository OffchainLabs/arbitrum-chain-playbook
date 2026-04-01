#!/usr/bin/env node

/**
 * Arbitrum Chain Playbook
 *
 * An interactive command-line tool for Arbitrum chain operations,
 * including chain deployment, node management, and various playbooks
 * for testing and educational purposes.
 */

import React from 'react';
import { render } from 'ink';
import { mainMenu } from './menu/mainMenu.js';
import logger from './utils/logger.js';
import { config } from 'dotenv';
import { initializeApp } from './init.js';
import { App } from './ui/App.js';

config();

/**
 * Main entry point
 */
async function main(): Promise<void> {
  try {
    // Initialize app state
    await initializeApp();

    // Start ink UI
    const { waitUntilExit } = render(<App />);

    // Show initial title
    logger.title('Arbitrum Chain Playbook');

    // Show main menu
    await mainMenu.show();

    // Wait for ink to cleanup
    await waitUntilExit();

    // Exit cleanly
    process.exit(0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_USE_AFTER_CLOSE') {
      // User pressed Ctrl+C, exit gracefully
      logger.newline();
      logger.info('Goodbye!');
      process.exit(0);
    }

    logger.error(`An unexpected error occurred: ${(error as Error).message}`);
    process.exit(1);
  }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  // Exit alternate screen buffer
  process.stdout.write('\x1b[?1049l');
  logger.newline();
  logger.info('Interrupted. Goodbye!');
  process.exit(0);
});

// Run the application
main();
