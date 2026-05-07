/**
 * Phase 7: glue between the experiment runners and the HTML template.
 *
 * Responsibilities:
 *   - Compute summary metrics from raw ExperimentRecord / NoBidRound / Unauthorized arrays.
 *   - Write the rendered HTML to `logs/timeboost-report-<chainId>-<ISO>.html`.
 *   - Print the path so the user can open it manually. We intentionally do NOT
 *     auto-launch a browser: the playbook also runs in CI / SSH where that
 *     would crash, and v2 plan §6/Phase 7 explicitly bans it.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderReport } from './reportTemplates/timeboostReport.html.js';
import type {
  AuctionEvent,
  ExperimentRecord,
  NoBidRoundRecord,
  ReportData,
  ReportSummary,
  UnauthorizedAttemptRecord,
} from './types.js';

const DEFAULT_LOG_DIR = 'logs';

export interface BuildReportInput {
  chainId: number;
  auctionContract: `0x${string}`;
  biddingToken: `0x${string}`;
  roundDurationSeconds: number;
  auctionClosingSeconds: number;
  reserveSubmissionSeconds: number;
  nonExpressDelayMsec: number;
  experiments: ExperimentRecord[];
  noBidRounds: NoBidRoundRecord[];
  unauthorized: UnauthorizedAttemptRecord[];
  events: AuctionEvent[];
}

/** Pure: turn raw runner output into the final ReportData (including summary). */
export function buildReportData(input: BuildReportInput): ReportData {
  return {
    generatedAtIso: new Date().toISOString(),
    chainId: input.chainId,
    auctionContract: input.auctionContract,
    biddingToken: input.biddingToken,
    roundDurationSeconds: input.roundDurationSeconds,
    auctionClosingSeconds: input.auctionClosingSeconds,
    reserveSubmissionSeconds: input.reserveSubmissionSeconds,
    nonExpressDelayMsec: input.nonExpressDelayMsec,
    experiments: input.experiments,
    noBidRounds: input.noBidRounds,
    unauthorized: input.unauthorized,
    events: input.events,
    summary: computeSummary(input),
  };
}

// ---------------------------------------------------------------------------
// Summary metrics
// ---------------------------------------------------------------------------

export function computeSummary(input: BuildReportInput): ReportSummary {
  const total = input.experiments.length;
  const expressTimeboosted = input.experiments.filter((e) => e.expressLane.timeboosted === true).length;
  const normalTimeboosted = input.experiments.filter((e) => e.normal.timeboosted === true).length;

  // Wall-clock latency: client receipt time minus client send time. Same
  // clock on both ends, so the number is meaningful (vs. comparing client
  // wall-clock to a chain timestamp with second-granularity).
  const elLatencies = input.experiments.map(
    (e) => (e.expressLane.receiptAtMs ?? e.expressLane.sentAtMs) - e.expressLane.sentAtMs,
  );
  const noLatencies = input.experiments.map((e) => (e.normal.receiptAtMs ?? e.normal.sentAtMs) - e.normal.sentAtMs);

  const crossBlock = input.experiments.filter((e) => e.normal.blockNumber > e.expressLane.blockNumber).length;

  return {
    totalExperiments: total,
    expressTimeboostedCount: expressTimeboosted,
    normalTimeboostedCount: normalTimeboosted,
    expressMedianLatencyMs: median(elLatencies),
    normalMedianLatencyMs: median(noLatencies),
    crossBlockNormalCount: crossBlock,
    noBidRoundsObserved: input.noBidRounds.length,
    unauthorizedAttempts: input.unauthorized.length,
    unauthorizedRecognisedCount: input.unauthorized.filter((u) => u.recognised).length,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// ---------------------------------------------------------------------------
// File output
// ---------------------------------------------------------------------------

export interface WriteReportInput {
  data: ReportData;
  /** Directory the file is written to. Defaults to `<cwd>/logs`. */
  logDir?: string;
}

export interface WriteReportResult {
  filePath: string;
  byteSize: number;
}

export function writeReport(input: WriteReportInput): WriteReportResult {
  const logDir = input.logDir ?? join(process.cwd(), DEFAULT_LOG_DIR);
  mkdirSync(logDir, { recursive: true });

  const html = renderReport(input.data);
  const fileName = buildReportFileName(input.data.chainId, input.data.generatedAtIso);
  const filePath = join(logDir, fileName);

  writeFileSync(filePath, html, 'utf8');

  return { filePath, byteSize: Buffer.byteLength(html, 'utf8') };
}

/** Build a filesystem-safe file name. ISO timestamps include `:` which Windows rejects. */
export function buildReportFileName(chainId: number, isoTimestamp: string): string {
  const safeIso = isoTimestamp.replace(/[:]/g, '-');
  return `timeboost-report-${chainId}-${safeIso}.html`;
}

/**
 * Convenience wrapper: build + write. Pure (no logger import) so it's safe
 * to call from smoke tests, snapshot tests, or anywhere else without side effects
 * beyond the file write itself. The demo runner is responsible for printing the
 * resulting path with whatever logger it likes.
 */
export function generateReport(input: BuildReportInput, logDir?: string): WriteReportResult {
  const data = buildReportData(input);
  return writeReport({ data, logDir });
}
