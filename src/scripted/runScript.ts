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
 *   130 cancelled (timeout, SIGINT, or SIGTERM)
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { ZodError, ZodTypeAny } from 'zod';
import {
  ScriptSchema,
  type ScriptDocument,
  type ChainRestorePolicy,
  MaliciousMintParamsSchema,
  BoldChallengeParamsSchema,
  TimeboostRunFullDemoParamsSchema,
} from './schema.js';
import { initializeApp, initializeChainMode } from '../init.js';
import { ChainEnv, setNodeManagerClass } from '../state/chainEnv/index.js';
import { OperationMode } from '../types/index.js';
import { cancellationManager, withCancellation, type OperationContext } from '../utils/cancellation.js';
import {
  initFileLogger,
  getLogFilePath,
  getJsonlFilePath,
  getTranscriptFilePath,
  getEventsFilePath,
  getLastErrorMessage,
  flushFileLogger,
} from '../utils/fileLogger.js';
import { enterDevnodeMode } from '../devnode/devnodeMode.js';
import { enterRemoteRpcMode } from '../remoteRpc/index.js';
import { NodeManager } from '../core/docker/nodeManager.js';
import logger from '../utils/logger.js';
import playbookRegistry from '../playbooks/index.js';
import type { HeadlessCommandSpec, PlaybookActionResult } from '../playbooks/types.js';
import {
  HEADLESS_COMMAND_MALICIOUS_MINT,
  HEADLESS_COMMAND_BOLD_CHALLENGE,
} from '../playbooks/malicious-validator/index.js';
import { HEADLESS_COMMAND_TIMEBOOST_RUN_FULL_DEMO } from '../playbooks/timeboost/index.js';
import {
  createHeadlessSessionId,
  installHeadlessSessionEnv,
  prepareHeadlessDockerContainers,
} from './headlessDocker.js';

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

  const startedAt = new Date().toISOString();

  initFileLogger({ captureRaw: true, structuredEvents: true });
  const logFile = getLogFilePath();
  const jsonlFile = getJsonlFilePath();
  const transcriptFile = getTranscriptFilePath();
  const eventsFile = getEventsFilePath();
  installHeadlessSignalHandlers();
  if (logFile) {
    logger.info(`Session log: ${logFile}`);
  }
  if (jsonlFile) {
    logger.info(`JSONL log: ${jsonlFile}`);
  }
  if (transcriptFile) {
    logger.info(`Transcript: ${transcriptFile}`);
  }
  if (eventsFile) {
    logger.info(`Events: ${eventsFile}`);
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
  const commandSpec = playbook.listHeadlessCommands?.().find((spec) => spec.command === script.command);
  if (playbook.listHeadlessCommands && !commandSpec) {
    logger.error(
      `Playbook "${script.playbook}" does not support headless command "${script.command}". Known: ${playbook
        .listHeadlessCommands()
        .map((spec) => spec.command)
        .join(', ')}`,
    );
    return EXIT_VALIDATION;
  }

  // ---------- Initialize app + mode ----------
  initializeApp();
  const headlessSessionId = createHeadlessSessionId();
  installHeadlessSessionEnv(headlessSessionId);
  if (script.mode === 'chain') {
    await prepareHeadlessDockerContainers(script.orphanContainerPolicy, headlessSessionId);
  }

  try {
    await enterMode(script.mode, resolveChainRestorePolicy(script.chainRestorePolicy, commandSpec));
  } catch (err) {
    logger.error(`Failed to enter mode "${script.mode}": ${(err as Error).message}`);
    writeResultEnvelope({
      script,
      logFile,
      jsonlFile,
      transcriptFile,
      eventsFile,
      startedAt,
      result: { success: false, message: `Failed to enter mode "${script.mode}".` },
      failure: buildFailureDiagnostics(err, null, EXIT_VALIDATION),
      exitCode: EXIT_VALIDATION,
    });
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
  const runState: { activeCtx: OperationContext | null } = { activeCtx: null };
  let result: PlaybookActionResult | null;
  try {
    result = await withCancellation(`headless:${script.playbook}:${script.command}`, async (ctx) => {
      runState.activeCtx = ctx;
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
  } catch (err) {
    const exitCode = EXIT_FATAL;
    writeResultEnvelope({
      script,
      logFile,
      jsonlFile,
      transcriptFile,
      eventsFile,
      startedAt,
      result: { success: false, message: err instanceof Error ? err.message : String(err) },
      failure: buildFailureDiagnostics(err, runState.activeCtx, exitCode),
      exitCode,
    });
    throw err;
  }

  if (result && runState.activeCtx?.signal.aborted) {
    await runState.activeCtx.runCleanup();
    result = null;
  }

  if (!result) {
    const exitCode = EXIT_CANCELLED;
    writeResultEnvelope({
      script,
      logFile,
      jsonlFile,
      transcriptFile,
      eventsFile,
      startedAt,
      result: { success: false, message: timedOut ? 'Headless run timed out.' : 'Headless run was cancelled.' },
      failure: {
        reason: timedOut ? 'timeout' : 'cancelled',
        failedAtStep: runState.activeCtx?.getCurrentStep() ?? null,
        completedSteps: runState.activeCtx?.getCompletedSteps() ?? [],
        exitCode,
      },
      exitCode,
    });
    return timedOut ? EXIT_CANCELLED : EXIT_CANCELLED;
  }

  const exitCode = result.success ? EXIT_OK : EXIT_BUSINESS_FAIL;
  writeResultEnvelope({
    script,
    logFile,
    jsonlFile,
    transcriptFile,
    eventsFile,
    startedAt,
    result,
    failure: result.success
      ? undefined
      : buildFailureDiagnostics(
          getLastErrorMessage() ?? result.message ?? 'Playbook reported failure.',
          runState.activeCtx,
          exitCode,
        ),
    exitCode,
  });

  return exitCode;
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

function validateCommandParams(script: ScriptDocument): { ok: true; value: unknown } | { ok: false; error: string } {
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
  if (playbook === 'timeboost') {
    if (command === HEADLESS_COMMAND_TIMEBOOST_RUN_FULL_DEMO) return TimeboostRunFullDemoParamsSchema;
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

function resolveChainRestorePolicy(
  requestedPolicy: ChainRestorePolicy,
  commandSpec: HeadlessCommandSpec | undefined,
): 'fresh' | 'reuse' {
  if (requestedPolicy === 'fresh' || requestedPolicy === 'reuse') {
    return requestedPolicy;
  }
  return commandSpec?.redeploysChain ? 'fresh' : 'reuse';
}

async function enterMode(mode: 'chain' | 'devnode' | 'remote', restorePolicy: 'fresh' | 'reuse'): Promise<void> {
  const chainEnv = ChainEnv.getInstance();
  switch (mode) {
    case 'chain':
      chainEnv.setOperationMode(OperationMode.CHAIN);
      await initializeChainMode({ headless: true, restorePolicy });
      return;
    case 'devnode':
      await enterDevnodeMode();
      return;
    case 'remote': {
      const ok = await enterRemoteRpcMode();
      if (!ok) {
        throw new Error(
          'Remote RPC mode failed to initialize. Check CHAIN_RPC, PARENT_CHAIN_RPC, CHAIN_DEPLOYMENT_TRANSACTION_HASH.',
        );
      }
      return;
    }
  }
}

interface ResultEnvelopeInput {
  script: ScriptDocument;
  logFile: string | null;
  jsonlFile: string | null;
  transcriptFile: string | null;
  eventsFile: string | null;
  startedAt: string;
  result: PlaybookActionResult;
  failure?: FailureDiagnostics;
  exitCode: number;
}

interface FailureDiagnostics {
  reason: string;
  failedAtStep: string | null;
  completedSteps: string[];
  errorMessage?: string;
  errorStack?: string;
  exitCode: number;
}

function writeResultEnvelope(input: ResultEnvelopeInput): void {
  try {
    const resultPath = writeResultFile({
      script: {
        mode: input.script.mode,
        playbook: input.script.playbook,
        command: input.script.command,
        chainRestorePolicy: input.script.chainRestorePolicy,
        orphanContainerPolicy: input.script.orphanContainerPolicy,
      },
      logFile: input.logFile,
      jsonlFile: input.jsonlFile,
      transcriptFile: input.transcriptFile,
      eventsFile: input.eventsFile,
      startedAt: input.startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: input.exitCode,
      result: input.result,
      ...(input.failure ? { failure: input.failure } : {}),
    });
    logger.info(`Result: ${resultPath}`);
  } catch (err) {
    logger.warn(`Failed to write result.json: ${(err as Error).message}`);
  }
}

function buildFailureDiagnostics(error: unknown, ctx: OperationContext | null, exitCode: number): FailureDiagnostics {
  const err = error instanceof Error ? error : null;
  return {
    reason: err?.name ?? 'failure',
    failedAtStep: ctx?.getCurrentStep() ?? null,
    completedSteps: ctx?.getCompletedSteps() ?? [],
    errorMessage: err?.message ?? String(error),
    ...(err?.stack ? { errorStack: err.stack } : {}),
    exitCode,
  };
}

function writeResultFile(result: unknown): string {
  const dir = path.join(process.cwd(), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(dir, `result-${ts}.json`);
  const serialized = JSON.stringify(result, bigintReplacer, 2);
  fs.writeFileSync(out, serialized);
  writeLatestFile(path.join(dir, 'latest-result.json'), serialized);
  if (typeof (result as { logFile?: unknown }).logFile === 'string') {
    writeLatestFile(path.join(dir, 'latest-log.txt'), `${(result as { logFile: string }).logFile}\n`);
  }
  if (typeof (result as { jsonlFile?: unknown }).jsonlFile === 'string') {
    writeLatestFile(path.join(dir, 'latest-jsonl.txt'), `${(result as { jsonlFile: string }).jsonlFile}\n`);
  }
  if (typeof (result as { transcriptFile?: unknown }).transcriptFile === 'string') {
    writeLatestFile(
      path.join(dir, 'latest-transcript.txt'),
      `${(result as { transcriptFile: string }).transcriptFile}\n`,
    );
  }
  if (typeof (result as { eventsFile?: unknown }).eventsFile === 'string') {
    writeLatestFile(path.join(dir, 'latest-events.txt'), `${(result as { eventsFile: string }).eventsFile}\n`);
  }
  return out;
}

function writeLatestFile(targetPath: string, content: string): void {
  const tmp = `${targetPath}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, targetPath);
}

function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function installHeadlessSignalHandlers(): void {
  let exiting = false;
  const handler = (signal: NodeJS.Signals) => {
    const handled = cancellationManager.handleSignal(signal);
    if (handled || exiting) return;

    exiting = true;
    logger.warn(`${signal} received before a cancellable operation was active. Exiting.`);
    void shutdown(EXIT_CANCELLED);
  };

  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

async function shutdown(code: number): Promise<never> {
  await flushFileLogger().catch(() => undefined);
  process.exit(code);
}

main()
  .then((code) => shutdown(code))
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error('Fatal:', err instanceof Error ? (err.stack ?? err.message) : err);
    await shutdown(EXIT_FATAL);
  });
