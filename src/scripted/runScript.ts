#!/usr/bin/env node
/**
 * Headless / scripted entry point for the Arbitrum Chain Playbook.
 *
 * Usage: yarn run:script <script.yaml|script.json>
 *
 * Reads a script document, validates it with zod, initializes the chosen
 * operation mode without prompting, and dispatches to the playbook's
 * runHeadless. Writes a structured result.json on completion.
 *
 * Exit codes:
 *   0   success
 *   1   fatal / unexpected error
 *   2   playbook reported failure
 *   3   script document or env validation failed
 *   64  usage error
 *   130 cancelled (timeout or SIGINT)
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { ZodError, ZodTypeAny } from 'zod';
import {
  ScriptSchema,
  type ScriptDocument,
  MaliciousMintParamsSchema,
  BoldChallengeParamsSchema,
} from './schema.js';
import { initializeApp, initializeChainMode } from '../init.js';
import { ChainEnv, setNodeManagerClass } from '../state/chainEnv/index.js';
import { OperationMode } from '../types/index.js';
import { withCancellation } from '../utils/cancellation.js';
import { initFileLogger, getLogFilePath } from '../utils/fileLogger.js';
import { enterDevnodeMode } from '../devnode/devnodeMode.js';
import { enterRemoteRpcMode } from '../remoteRpc/index.js';
import { NodeManager } from '../core/docker/nodeManager.js';
import logger from '../utils/logger.js';
import playbookRegistry from '../playbooks/index.js';
import {
  HEADLESS_COMMAND_MALICIOUS_MINT,
  HEADLESS_COMMAND_BOLD_CHALLENGE,
} from '../playbooks/malicious-validator/index.js';

const EXIT_OK = 0;
const EXIT_FATAL = 1;
const EXIT_BUSINESS_FAIL = 2;
const EXIT_VALIDATION = 3;
const EXIT_USAGE = 64;
const EXIT_CANCELLED = 130;

setNodeManagerClass(NodeManager);

async function main(): Promise<number> {
  const scriptPath = process.argv[2];
  if (!scriptPath) {
    process.stderr.write('Usage: yarn run:script <script.yaml|script.json>\n');
    return EXIT_USAGE;
  }

  initFileLogger();
  const logFile = getLogFilePath();
  if (logFile) {
    logger.info(`Session log: ${logFile}`);
  }

  // ---------- Load + parse ----------
  let raw: string;
  try {
    raw = fs.readFileSync(path.resolve(scriptPath), 'utf-8');
  } catch (err) {
    logger.error(`Could not read script "${scriptPath}": ${(err as Error).message}`);
    return EXIT_USAGE;
  }

  const parsed = parseDocument(scriptPath, raw);
  if (!parsed.ok) {
    logger.error(parsed.error);
    return EXIT_VALIDATION;
  }

  const scriptResult = ScriptSchema.safeParse(parsed.value);
  if (!scriptResult.success) {
    logger.error(`Invalid script document:\n${formatZodError(scriptResult.error)}`);
    return EXIT_VALIDATION;
  }
  const script = scriptResult.data;

  const paramsResult = validateCommandParams(script);
  if (!paramsResult.ok) {
    logger.error(paramsResult.error);
    return EXIT_VALIDATION;
  }
  const params = paramsResult.value;

  // ---------- Find playbook ----------
  const playbook = playbookRegistry.get(script.playbook);
  if (!playbook) {
    logger.error(`Unknown playbook "${script.playbook}".`);
    return EXIT_VALIDATION;
  }
  if (!playbook.runHeadless) {
    logger.error(`Playbook "${script.playbook}" does not support headless execution.`);
    return EXIT_VALIDATION;
  }

  // ---------- Initialize app + mode ----------
  initializeApp();

  try {
    await enterMode(script.mode);
  } catch (err) {
    logger.error(`Failed to enter mode "${script.mode}": ${(err as Error).message}`);
    return EXIT_VALIDATION;
  }

  const activeMode = ChainEnv.getInstance().operationMode;
  const matchesSupported = playbook.supportedModes.includes(activeMode);
  if (!matchesSupported) {
    logger.error(
      `Playbook "${script.playbook}" does not support mode "${script.mode}". Supported: ${playbook.supportedModes.join(', ')}.`,
    );
    return EXIT_VALIDATION;
  }

  // ---------- Run ----------
  let timedOut = false;
  const result = await withCancellation(`headless:${script.playbook}:${script.command}`, async (ctx) => {
    if (script.timeoutSeconds) {
      const timer = setTimeout(() => {
        timedOut = true;
        logger.warn(`Timeout (${script.timeoutSeconds}s) reached. Cancelling...`);
        ctx.cancel();
      }, script.timeoutSeconds * 1000);
      ctx.onCleanup(async () => clearTimeout(timer));
    }
    return await playbook.runHeadless!(script.command, params, ctx);
  });

  if (!result) {
    return timedOut ? EXIT_CANCELLED : EXIT_CANCELLED;
  }

  // ---------- Write result.json ----------
  try {
    const resultPath = writeResultFile(result);
    logger.info(`Result: ${resultPath}`);
  } catch (err) {
    logger.warn(`Failed to write result.json: ${(err as Error).message}`);
  }

  return result.success ? EXIT_OK : EXIT_BUSINESS_FAIL;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDocument(filePath: string, raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === '.json') {
      return { ok: true, value: JSON.parse(raw) };
    }
    return { ok: true, value: yaml.load(raw) };
  } catch (err) {
    return { ok: false, error: `Failed to parse ${ext || 'document'}: ${(err as Error).message}` };
  }
}

function validateCommandParams(
  script: ScriptDocument,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const schema = pickParamsSchema(script.playbook, script.command);
  if (!schema) {
    // No specific schema registered — pass through. The playbook's own
    // mergeXxxParams will fall back to defaults; unknown fields are ignored.
    return { ok: true, value: script.params };
  }
  const r = schema.safeParse(script.params);
  if (!r.success) {
    return {
      ok: false,
      error: `Invalid params for ${script.playbook}/${script.command}:\n${formatZodError(r.error)}`,
    };
  }
  return { ok: true, value: r.data };
}

function pickParamsSchema(playbook: string, command: string): ZodTypeAny | null {
  if (playbook === 'malicious-validator') {
    if (command === HEADLESS_COMMAND_MALICIOUS_MINT) return MaliciousMintParamsSchema;
    if (command === HEADLESS_COMMAND_BOLD_CHALLENGE) return BoldChallengeParamsSchema;
  }
  return null;
}

function formatZodError(err: ZodError): string {
  return err.issues
    .map((i) => {
      const pathStr = i.path.map((p) => String(p)).join('.') || '<root>';
      return `  - ${pathStr}: ${i.message}`;
    })
    .join('\n');
}

async function enterMode(mode: 'chain' | 'devnode' | 'remote'): Promise<void> {
  const chainEnv = ChainEnv.getInstance();
  switch (mode) {
    case 'chain':
      chainEnv.setOperationMode(OperationMode.CHAIN);
      await initializeChainMode({ headless: true });
      return;
    case 'devnode':
      await enterDevnodeMode();
      return;
    case 'remote': {
      const ok = await enterRemoteRpcMode();
      if (!ok) {
        throw new Error('Remote RPC mode failed to initialize. Check CHAIN_RPC, PARENT_CHAIN_RPC, CHAIN_DEPLOYMENT_TRANSACTION_HASH.');
      }
      return;
    }
  }
}

function writeResultFile(result: unknown): string {
  const dir = path.join(process.cwd(), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(dir, `result-${ts}.json`);
  fs.writeFileSync(out, JSON.stringify(result, bigintReplacer, 2));
  return out;
}

function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Fatal:', err instanceof Error ? err.stack ?? err.message : err);
    process.exit(EXIT_FATAL);
  });
