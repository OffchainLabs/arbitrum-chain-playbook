/**
 * Graceful cancellation utilities.
 *
 * Provides an OperationContext (AbortSignal + LIFO cleanup stack + step tracking),
 * a singleton CancellationManager that bridges SIGINT to the active context,
 * and a withCancellation() wrapper for call sites.
 */

import chalk from 'chalk';
import logger from './logger.js';

/**
 * Custom error thrown when an operation is cancelled via Ctrl+C.
 */
export class CancellationError extends Error {
  constructor(message = 'Operation cancelled') {
    super(message);
    this.name = 'CancellationError';
  }
}

/**
 * Tracks an in-flight operation: carries an AbortSignal, a LIFO cleanup
 * stack, and completed/current step names for the cancellation summary.
 */
export class OperationContext {
  private controller = new AbortController();
  private cleanupStack: Array<() => Promise<void>> = [];
  private completedSteps: string[] = [];
  private currentStepName: string | null = null;

  /** The AbortSignal for this operation. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Cancel the operation (abort the signal). */
  cancel(): void {
    this.controller.abort();
  }

  /** Throw CancellationError if the signal has been aborted. */
  throwIfCancelled(): void {
    if (this.controller.signal.aborted) {
      throw new CancellationError();
    }
  }

  /** Register an async cleanup callback (executed LIFO on cancellation). */
  onCleanup(fn: () => Promise<void>): void {
    this.cleanupStack.push(fn);
  }

  /** Run all cleanup callbacks in LIFO order. Logs errors but does not rethrow. */
  async runCleanup(): Promise<void> {
    const fns = [...this.cleanupStack].reverse();
    for (const fn of fns) {
      try {
        await fn();
      } catch (err) {
        logger.debug(`Cleanup error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Mark the beginning of a named step. */
  stepStarted(name: string): void {
    this.currentStepName = name;
  }

  /** Mark a step as completed. */
  stepCompleted(name: string): void {
    this.completedSteps.push(name);
    if (this.currentStepName === name) {
      this.currentStepName = null;
    }
  }

  /** Steps that finished before cancellation. */
  getCompletedSteps(): string[] {
    return [...this.completedSteps];
  }

  /** The step that was in progress when cancelled (if any). */
  getCurrentStep(): string | null {
    return this.currentStepName;
  }
}

/**
 * Singleton that bridges process SIGINT to the active OperationContext.
 *
 * First Ctrl+C cancels the active operation.
 * Second Ctrl+C force-exits the process.
 */
class CancellationManager {
  private activeCtx: OperationContext | null = null;
  private forceExitPending = false;

  /** Set the active operation context. */
  register(ctx: OperationContext): void {
    this.activeCtx = ctx;
    this.forceExitPending = false;
  }

  /** Clear the active context. */
  unregister(): void {
    this.activeCtx = null;
    this.forceExitPending = false;
  }

  /**
   * Handle a SIGINT.
   * @returns true if the signal was handled (caller should NOT exit),
   *          false if there is no active operation (caller should exit).
   */
  handleSigint(): boolean {
    if (!this.activeCtx) {
      return false;
    }

    if (this.forceExitPending) {
      // Second Ctrl+C → force exit
      logger.newline();
      logger.warn('Force exit.');
      process.exit(1);
    }

    // First Ctrl+C → cancel the operation
    logger.newline();
    logger.warn('Cancelling operation... (press Ctrl+C again to force exit)');
    this.activeCtx.cancel();
    this.forceExitPending = true;
    return true;
  }
}

/** Singleton instance. */
export const cancellationManager = new CancellationManager();

/**
 * A sleep that respects an AbortSignal.
 * Resolves after `ms` milliseconds, or rejects with CancellationError
 * if the signal is aborted before the timeout fires.
 * Falls back to a regular setTimeout if no signal is provided.
 */
export function cancellableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new CancellationError());
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(new CancellationError());
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Print a summary of what was completed vs. cancelled.
 */
function printCancellationSummary(name: string, ctx: OperationContext): void {
  logger.newline();
  logger.warn(`${name} was cancelled.`);

  const completed = ctx.getCompletedSteps();
  const current = ctx.getCurrentStep();

  if (completed.length > 0 || current) {
    logger.raw('');
    logger.raw('  Progress:');
    for (const step of completed) {
      logger.raw(`    ${chalk.green('✔')} ${step}`);
    }
    if (current) {
      logger.raw(`    ${chalk.red('✖')} ${current} ${chalk.dim('(cancelled)')}`);
    }
  }

  logger.newline();
}

/**
 * Wrap an async operation with cancellation support.
 *
 * Creates an OperationContext, registers it with the CancellationManager,
 * and catches CancellationError to run cleanup and print a summary.
 *
 * @returns The result of `fn`, or `null` if the operation was cancelled.
 */
export async function withCancellation<T>(name: string, fn: (ctx: OperationContext) => Promise<T>): Promise<T | null> {
  const ctx = new OperationContext();
  cancellationManager.register(ctx);

  try {
    const result = await fn(ctx);
    return result;
  } catch (err) {
    await ctx.runCleanup();
    if (err instanceof CancellationError) {
      printCancellationSummary(name, ctx);
      return null;
    }
    throw err;
  } finally {
    cancellationManager.unregister();
  }
}
