/**
 * Phase 4: patch the sequencer's `node-config.json` so the running Nitro
 * node honours Timeboost.
 *
 * Required changes (v2 plan §0 #2 / #6):
 *   - http.api: add 'auctioneer', 'timeboost'
 *   - ws.api:   add 'auctioneer', 'timeboost'
 *   - execution.sequencer.timeboost.{enable, auction-contract-address,
 *       auctioneer-address, redis-url}
 *   - node.transaction-streamer.track-block-metadata-from = 1
 *       (without this the receipt won't have `timeboosted`)
 *
 * The Linux fix for `host.docker.internal` resolution is applied at container
 * launch time via NodeManager's new `extraDockerArgs` option (see
 * `src/core/docker/nodeManager.ts` and `restartSequencerWithTimeboost` below).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Address } from 'viem';
import { NODE_CONFIG_FILENAME } from '../../types/constants.js';

export interface TimeboostSequencerPatch {
  auctionContractAddress: Address;
  auctioneerAddress: Address;
  redisUrl: string; // typically 'redis://host.docker.internal:6379'
}

/**
 * Apply ONLY the changes that need to be in place before the initial sequencer
 * starts (no Timeboost config yet, since we don't have an auction address):
 *   - disable block validator (chain's wasmModuleRoot may not match image)
 *   - drop bold strategy so the staker doesn't try MakeNodes
 *   - turn on track-block-metadata-from so receipts will eventually surface
 *     `timeboosted` once Timeboost is enabled
 */
export function patchSequencerConfigForPreFlight(
  configPath: string = path.join(process.cwd(), NODE_CONFIG_FILENAME),
): void {
  const cfg = readJson(configPath);
  applyValidationSkip(cfg);
  applyTrackBlockMetadata(cfg);
  writeJson(configPath, cfg);
}

/**
 * Apply the Timeboost-runtime patch (auction address + auctioneer address +
 * redis url + http/ws API namespaces). Called AFTER the auction is deployed.
 * Idempotent with patchSequencerConfigForPreFlight.
 */
export function patchSequencerConfigForTimeboost(
  patch: TimeboostSequencerPatch,
  configPath: string = path.join(process.cwd(), NODE_CONFIG_FILENAME),
): void {
  const cfg = readJson(configPath);

  // Re-apply pre-flight pieces so a single call covers both phases.
  applyValidationSkip(cfg);
  applyTrackBlockMetadata(cfg);

  ensureApiNamespaces(cfg, 'http');
  ensureApiNamespaces(cfg, 'ws');

  const execution = (cfg.execution ??= {}) as Record<string, unknown>;
  const sequencer = (execution.sequencer ??= {}) as Record<string, unknown>;
  sequencer.timeboost = {
    enable: true,
    'auction-contract-address': patch.auctionContractAddress,
    'auctioneer-address': patch.auctioneerAddress,
    'redis-url': patch.redisUrl,
  };

  writeJson(configPath, cfg);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readJson(path_: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path_, 'utf8')) as Record<string, unknown>;
}

function writeJson(path_: string, cfg: Record<string, unknown>): void {
  writeFileSync(path_, JSON.stringify(cfg, null, 2), 'utf8');
}

function applyValidationSkip(cfg: Record<string, unknown>): void {
  const node = (cfg.node ??= {}) as Record<string, unknown>;
  const blockValidator = (node['block-validator'] ??= {}) as Record<string, unknown>;
  blockValidator['enable'] = false;
  const staker = (node.staker ??= {}) as Record<string, unknown>;
  const dangerous = (staker.dangerous ??= {}) as Record<string, unknown>;
  dangerous['without-block-validator'] = true;
  dangerous['ignore-rollup-wasm-module-root'] = true;
  const bold = node['bold'] as Record<string, unknown> | undefined;
  if (bold && typeof bold === 'object') {
    delete bold['strategy'];
    if (Object.keys(bold).length === 0) delete node['bold'];
  }
}

function applyTrackBlockMetadata(cfg: Record<string, unknown>): void {
  const node = (cfg.node ??= {}) as Record<string, unknown>;
  const txStreamer = (node['transaction-streamer'] ??= {}) as Record<string, unknown>;
  txStreamer['track-block-metadata-from'] = 1;
}

function ensureApiNamespaces(cfg: Record<string, unknown>, key: 'http' | 'ws'): void {
  const node = (cfg[key] ??= {}) as Record<string, unknown>;
  const apis = Array.isArray(node.api) ? (node.api as string[]) : [];
  for (const ns of ['auctioneer', 'timeboost']) {
    if (!apis.includes(ns)) apis.push(ns);
  }
  node.api = apis;
}

/**
 * Standard `extraDockerArgs` that any Nitro container interacting with the
 * Timeboost stack should be launched with. Right now this is just the Linux
 * host-gateway alias that lets `host.docker.internal` resolve to the host
 * (no-op on macOS where Docker Desktop sets it automatically).
 */
export const TIMEBOOST_EXTRA_DOCKER_ARGS: string[] = [
  '--add-host=host.docker.internal:host-gateway',
];
