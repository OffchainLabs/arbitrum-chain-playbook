/**
 * Session-based file logger (winston).
 *
 * Writes two parallel files per session:
 *   - cli-<timestamp>.log    Human-readable, ANSI-stripped, line format.
 *   - cli-<timestamp>.jsonl  One JSON object per log line {ts, level, message}.
 *                            Intended for AI / tooling consumers that want
 *                            to stream and `jq` the run.
 *
 * Also patches global fetch to time JSON-RPC calls.
 */

import { createLogger, format, transports, type Logger } from 'winston';
import * as path from 'path';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'fs';

const LOG_DIR = path.join(process.cwd(), 'logs');
const MAX_LOG_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_FILES = 5;

// ANSI escape sequence stripper. Many call sites pass chalk-colored strings;
// the on-disk log should be plain text so jq / grep work cleanly.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, '');
}

let winstonLogger: Logger | null = null;
let logFilePath: string | null = null;
let jsonlFilePath: string | null = null;

export function getLogLevel(): string {
  const level = (process.env.LOG_LEVEL || 'info').toLowerCase();
  const valid = ['error', 'warn', 'info', 'debug'];
  return valid.includes(level) ? level : 'info';
}

export function getLogFilePath(): string | null {
  return logFilePath;
}

export function getJsonlFilePath(): string | null {
  return jsonlFilePath;
}

/**
 * Flush pending writes and close transports. The headless runner awaits this
 * before process.exit so log lines aren't dropped on a fast-fail path.
 */
export async function flushFileLogger(): Promise<void> {
  const l = winstonLogger;
  if (!l) return;
  await new Promise<void>((resolve) => {
    l.on('finish', () => resolve());
    l.end();
  });
}

/** Call once at startup. */
export function initFileLogger(): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    cleanOldLogs();

    const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
    logFilePath = path.join(LOG_DIR, `cli-${timestamp}.log`);
    jsonlFilePath = path.join(LOG_DIR, `cli-${timestamp}.jsonl`);

    const level = getLogLevel();

    const textFormat = format.printf((info) => {
      const lvl = (info.level as string).toUpperCase().padEnd(5);
      const message = stripAnsi(String(info.message));
      let line = `${info.timestamp as string} [${lvl}] ${message}`;
      if (info.stack) line += `\n${stripAnsi(String(info.stack))}`;
      return line;
    });

    const jsonlFormat = format.printf((info) => {
      const payload: Record<string, unknown> = {
        ts: info.timestamp,
        level: info.level,
        message: stripAnsi(String(info.message)),
      };
      if (info.stack) payload.stack = stripAnsi(String(info.stack));
      return JSON.stringify(payload);
    });

    winstonLogger = createLogger({
      level,
      format: format.combine(format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' })),
      transports: [
        new transports.File({
          filename: logFilePath,
          maxsize: MAX_FILE_SIZE,
          maxFiles: MAX_FILES,
          format: textFormat,
        }),
        new transports.File({
          filename: jsonlFilePath,
          maxsize: MAX_FILE_SIZE,
          maxFiles: MAX_FILES,
          format: jsonlFormat,
        }),
      ],
    });

    winstonLogger.info(`Session started (log level: ${level})`);
    winstonLogger.info(`Log file: ${logFilePath}`);
    winstonLogger.info(`JSONL log: ${jsonlFilePath}`);

    instrumentRpcTiming();
  } catch {
    winstonLogger = null;
    logFilePath = null;
    jsonlFilePath = null;
  }
}

function cleanOldLogs(): void {
  try {
    const files = readdirSync(LOG_DIR);
    const now = Date.now();
    for (const file of files) {
      if (!file.startsWith('cli-') || !(file.endsWith('.log') || file.endsWith('.jsonl'))) continue;
      const fullPath = path.join(LOG_DIR, file);
      try {
        const stats = statSync(fullPath);
        if (now - stats.mtimeMs > MAX_LOG_AGE_MS) {
          unlinkSync(fullPath);
        }
      } catch {
        // skip
      }
    }
  } catch {
    // ignore
  }
}

/** No-ops when the logger hasn't been initialized. */
export const fileLogger = {
  info: (message: string): void => {
    winstonLogger?.info(message);
  },

  warn: (message: string): void => {
    winstonLogger?.warn(message);
  },

  error: (message: string, stack?: string): void => {
    if (stack) {
      winstonLogger?.error(message, { stack });
    } else {
      winstonLogger?.error(message);
    }
  },

  debug: (message: string): void => {
    winstonLogger?.debug(message);
  },
};

/** Wrap globalThis.fetch to log JSON-RPC timing. Warns on calls > 1 s. */
function instrumentRpcTiming(): void {
  if (!winstonLogger) return;

  const originalFetch = globalThis.fetch;
  if (!originalFetch) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- undici vs native fetch type mismatch
  globalThis.fetch = async function (input: any, init?: any): Promise<Response> {
    if (!init?.body || typeof init.body !== 'string') {
      return originalFetch(input, init);
    }

    let rpcMethod = '';
    try {
      const body = JSON.parse(init.body);
      if (!body.jsonrpc) {
        return originalFetch(input, init);
      }
      rpcMethod = body.method || 'unknown';
    } catch {
      return originalFetch(input, init);
    }

    const start = Date.now();
    try {
      const response = await originalFetch(input, init);
      const elapsed = Date.now() - start;

      fileLogger.debug(`RPC ${rpcMethod} -> ${response.status} (${elapsed}ms)`);
      if (elapsed > 1000) {
        fileLogger.warn(`Slow RPC call: ${rpcMethod} took ${elapsed}ms (>1s)`);
      }

      return response;
    } catch (error) {
      const elapsed = Date.now() - start;
      fileLogger.error(
        `RPC ${rpcMethod} failed after ${elapsed}ms: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  };
}
