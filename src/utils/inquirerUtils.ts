/**
 * Utilities for inquirer prompts.
 *
 * Stdin draining is now handled by the breadcrumb module (rendered before each
 * menu prompt). This file provides the waitForEnter helper used after
 * displaying read-only information.
 */

import { drainStdin } from './breadcrumb.js';

/**
 * Wait until the user presses Enter.
 *
 * Note: We intentionally use readline (canonical mode) here instead of raw-mode
 * key handling. It's much harder to end up in a stuck state when mixing inquirer
 * (which also manipulates stdin) with custom raw-mode listeners.
 */
/**
 * Build an inquirer `validate` fn that accepts a positive number. `parse`
 * controls how the raw input is interpreted — the default `parseFloat` suits
 * decimal amounts (e.g. ETH), while `(s) => parseInt(s, 10)` suits integer counts.
 */
export function positiveNumberValidator(
  parse: (input: string) => number = parseFloat,
): (input: string) => true | string {
  return (input: string) => {
    const num = parse(input);
    return !isNaN(num) && num > 0 ? true : 'Please enter a valid positive number';
  };
}

export async function waitForEnter(message = 'Press Enter to continue...'): Promise<void> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin || !(stdin as any).isTTY) return;

  await drainStdin();

  // Lazy import to keep this utility lightweight and avoid top-level deps in tests.
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });

  await new Promise<void>((resolve) => {
    rl.question(`? ${message}`, () => {
      rl.close();
      resolve();
    });
  });
}
