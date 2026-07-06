import chalk from 'chalk';
import { fileLogger } from './fileLogger.js';

class Breadcrumb {
  private path: string[] = ['Main'];

  push(segment: string): void {
    this.path.push(segment);
    fileLogger.debug(`[NAV] Enter: ${this.path.join(' > ')}`);
  }

  pop(): void {
    if (this.path.length > 1) {
      const leaving = this.path.pop();
      fileLogger.debug(`[NAV] Leave: ${leaving} -> ${this.path.join(' > ')}`);
    }
  }

  render(): void {
    const trail = this.path
      .map((s, i) => (i === this.path.length - 1 ? chalk.bold.white(s) : chalk.dim(s)))
      .join(chalk.dim(' > '));
    console.log();
    console.log(`  ${trail}`);
    console.log();
  }
}

/** Discard any buffered stdin so stale keystrokes don't leak into the next prompt. */
async function drainStdin(): Promise<void> {
  const stdin = process.stdin;
  if (!stdin?.isTTY) return;
  try {
    const wasPaused = stdin.isPaused();

    // Ensure we're in flowing mode briefly so any OS-level buffered bytes are delivered.
    stdin.resume();

    // Let any already-buffered bytes arrive via I/O poll.
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Drain bytes for a short window; this reliably clears "type-ahead" across prompts.
    const onData = () => {
      /* discard */
    };
    stdin.on('data', onData);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    stdin.off('data', onData);

    // Also drain anything still sitting in Node's internal buffer.
    stdin.pause();
    while (stdin.read() !== null) {
      /* discard */
    }
    stdin.resume();
    if (wasPaused) stdin.pause();
  } catch {
    /* best-effort */
  }
}

export const breadcrumb = new Breadcrumb();
export { drainStdin };
