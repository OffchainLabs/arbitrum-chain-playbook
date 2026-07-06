/**
 * Shared UI utilities for the CLI application.
 *
 * Provides a multi-step progress tracker that displays real-time step
 * counters with elapsed time and ETA.
 */

import ora, { type Ora } from 'ora';
import chalk from 'chalk';

/**
 * Format a duration in milliseconds to a human-readable string.
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Multi-step progress tracker with animated spinners.
 *
 * Displays real-time step counters like:
 *   [1/5] Generating validator keys (2s)
 *   [2/5] Sending test tokens (8s)
 *   [3/5] Deploying rollup contracts...
 *
 * Usage:
 * ```
 * const tracker = new StepTracker([
 *   'Generating keys',
 *   'Deploying contracts',
 *   'Starting node',
 * ]);
 *
 * tracker.start();          // starts step 1/3
 * await generateKeys();
 * tracker.start();          // completes step 1, starts step 2
 * await deployContracts();
 * tracker.start();          // completes step 2, starts step 3
 * await startNode();
 * tracker.complete();       // completes step 3, shows summary
 * ```
 */
export class StepTracker {
  private steps: string[];
  private currentStep: number = -1;
  private spinner: Ora | null = null;
  private stepStartTime: number = 0;
  private totalStartTime: number;
  private completedStepTimes: number[] = [];

  constructor(steps: string[]) {
    this.steps = steps;
    this.totalStartTime = Date.now();
  }

  /**
   * Start the next step (or a specific step by index).
   * Automatically completes the previous step with success.
   */
  start(stepIndex?: number): void {
    if (this.spinner) {
      this._succeedCurrent();
    }

    const idx = stepIndex ?? this.currentStep + 1;
    this.currentStep = idx;
    this.stepStartTime = Date.now();

    const label = this._formatLabel(idx);
    const eta = this._estimateEta(idx);
    const etaSuffix = eta ? chalk.dim(` (ETA: ~${eta})`) : '';

    this.spinner = ora({
      text: `${label}${etaSuffix}`,
      spinner: 'dots',
    }).start();
  }

  /**
   * Update the spinner text for sub-progress within a step.
   */
  update(detail: string): void {
    if (this.spinner) {
      const prefix = this._formatPrefix(this.currentStep);
      this.spinner.text = `${prefix} ${this.steps[this.currentStep]} ${chalk.dim(`- ${detail}`)}`;
    }
  }

  /**
   * Mark the current step as succeeded (stops spinner with check mark).
   */
  succeed(message?: string): void {
    this._succeedCurrent(message);
  }

  /**
   * Mark the current step as failed (stops spinner with X mark).
   */
  fail(message?: string): void {
    if (!this.spinner) return;
    const elapsed = formatDuration(Date.now() - this.stepStartTime);
    const prefix = this._formatPrefix(this.currentStep);
    const text = `${prefix} ${message ?? this.steps[this.currentStep]} ${chalk.dim(`(${elapsed})`)}`;
    this.spinner.fail(text);
    this.spinner = null;
  }

  /**
   * Complete all remaining steps and show summary.
   */
  complete(summaryMessage?: string): void {
    if (this.spinner) {
      this._succeedCurrent();
    }
    const totalTime = formatDuration(Date.now() - this.totalStartTime);
    console.log();
    console.log(
      chalk.green('✔'),
      chalk.green.bold(summaryMessage ?? `All ${this.steps.length} steps completed`),
      chalk.dim(`(${totalTime} total)`),
    );
  }

  /**
   * Estimate remaining time based on average duration of completed steps.
   */
  private _estimateEta(currentIdx: number): string | null {
    if (this.completedStepTimes.length === 0) return null;
    const avgStepTime = this.completedStepTimes.reduce((a, b) => a + b, 0) / this.completedStepTimes.length;
    const remainingSteps = this.steps.length - currentIdx;
    const estimatedMs = avgStepTime * remainingSteps;
    return formatDuration(estimatedMs);
  }

  private _succeedCurrent(message?: string): void {
    if (!this.spinner) return;
    const elapsed = Date.now() - this.stepStartTime;
    this.completedStepTimes.push(elapsed);
    const prefix = this._formatPrefix(this.currentStep);
    const text = `${prefix} ${message ?? this.steps[this.currentStep]} ${chalk.dim(`(${formatDuration(elapsed)})`)}`;
    this.spinner.succeed(text);
    this.spinner = null;
  }

  private _formatPrefix(idx: number): string {
    return chalk.cyan(`[${idx + 1}/${this.steps.length}]`);
  }

  private _formatLabel(idx: number): string {
    return `${this._formatPrefix(idx)} ${this.steps[idx]}`;
  }
}
