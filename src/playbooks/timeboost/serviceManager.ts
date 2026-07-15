/**
 * Phase 3: orchestration of the auxiliary containers Timeboost requires.
 *
 *   - Redis (`timeboost-redis`) — used by both the auctioneer and (optionally)
 *     the sequencer's ExpressLaneService for cross-instance coordination.
 *   - bid-validator (`timeboost-bid-validator`) — exposes `auctioneer_submitBid`
 *     over HTTP, validates signatures, pushes to Redis stream.
 *   - auctioneer-server (`timeboost-auctioneer`) — consumes Redis stream,
 *     resolves auctions on-chain at T-`auctionClosingSeconds`.
 *
 * v2 plan §0 #1: we do NOT use a custom docker network. Containers expose
 * their ports on the host; cross-container references go through
 * `host.docker.internal` (auto on macOS, requires `--add-host=...:host-gateway`
 * on Linux — applied by NodeManager extension in Phase 4).
 *
 * v2 plan §0 #5: bid-validator uses `--bid-validator.rpc-endpoint`, NOT
 * `sequencer-endpoint`. The auctioneer-server is the one that uses
 * `--auctioneer-server.sequencer-endpoint`.
 */

import { quietDockerCommand } from '../../core/docker/dockerCli.js';
import type { Address } from 'viem';
import { log, sleep } from './util.js';

const REDIS_CONTAINER = 'timeboost-redis';
const BID_VALIDATOR_CONTAINER = 'timeboost-bid-validator';
const AUCTIONEER_CONTAINER = 'timeboost-auctioneer';

const REDIS_HOST_PORT = 6379;
export const BID_VALIDATOR_HOST_PORT = 9372;
const AUCTIONEER_HTTP_HOST_PORT = 9373; // not strictly required; helpful for poking

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ServiceManagerConfig {
  /**
   * Docker image that ships the `autonomous-auctioneer` binary. v2 plan §3
   * pre-flight: must be verified to contain the binary. We `--entrypoint`
   * override to reach it regardless of the image's default ENTRYPOINT.
   */
  auctioneerImage: string;
  /** ExpressLaneAuction proxy address. */
  auctionContractAddress: Address;
  /**
   * Auctioneer's address (NOT private key). Required by bid-validator to
   * pre-validate bids via `eth_call`. Mirrors auctioneer-server.wallet's
   * derived address.
   */
  auctioneerAddress: Address;
  /**
   * RPC URL the bid-validator uses to query the auction contract. From the
   * validator's POV this can point at the sequencer or any other RPC for the
   * child chain — it doesn't submit txs from here.
   */
  childChainRpcEndpoint: string;
  /**
   * RPC URL the auctioneer-server uses to send `resolve*Auction` txs to.
   * Should be the sequencer's HTTP endpoint.
   */
  sequencerRpcEndpoint: string;
  /**
   * Auctioneer's hot wallet — pays gas to send resolve txs and holds
   * AUCTIONEER_ROLE on the auction contract.
   */
  auctioneerPrivateKey: `0x${string}`;
}

export interface ServiceHandles {
  redisContainerId: string;
  bidValidatorContainerId: string;
  auctioneerContainerId: string;
  redisHostUrl: string; // for sequencer node config + reporting
  bidValidatorHostUrl: string;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function startTimeboostServices(cfg: ServiceManagerConfig): Promise<ServiceHandles> {
  // Always rip down any leftover containers first to avoid name collisions
  // from a previous failed run.
  await stopTimeboostServices();

  log.info('Starting Redis...');
  const redisId = await runDocker([
    'run -d',
    `--name ${REDIS_CONTAINER}`,
    `-p ${REDIS_HOST_PORT}:6379`,
    'redis:7-alpine',
  ]);
  await waitForRedis();
  log.success(`Redis up on host port ${REDIS_HOST_PORT}`);

  log.info('Starting bid-validator...');
  const bidValidatorId = await runDocker([
    'run -d',
    `--name ${BID_VALIDATOR_CONTAINER}`,
    `-p ${BID_VALIDATOR_HOST_PORT}:9372`,
    `--add-host=host.docker.internal:host-gateway`, // Linux fallback (no-op on Mac)
    `--entrypoint /usr/local/bin/autonomous-auctioneer`,
    cfg.auctioneerImage,
    `--bid-validator.enable=true`,
    `--bid-validator.rpc-endpoint=${cfg.childChainRpcEndpoint}`,
    `--bid-validator.auction-contract-address=${cfg.auctionContractAddress}`,
    `--bid-validator.auctioneer-address=${cfg.auctioneerAddress}`,
    `--bid-validator.redis-url=redis://host.docker.internal:${REDIS_HOST_PORT}`,
    `--auctioneer-server.enable=false`,
    `--http.api=auctioneer`,
    `--http.addr=0.0.0.0`,
    `--http.port=9372`,
    `--http.corsdomain=*`,
    `--http.vhosts=*`,
  ]);
  await waitForLogLine(BID_VALIDATOR_CONTAINER, /BidValidator|HTTP server started|listening/, 30_000);
  log.success(`bid-validator up on host port ${BID_VALIDATOR_HOST_PORT}`);

  log.info('Starting auctioneer-server...');
  // The autonomous-auctioneer binary doesn't auto-create its db-directory and
  // requires it pre-exist. Wrap the entrypoint in `sh -c` so we mkdir first.
  // mkdir + exec joined with `&&`; the binary's flags are space-separated
  // arguments to that `exec` call.
  const auctioneerArgs = [
    `--auctioneer-server.enable=true`,
    `--auctioneer-server.auction-contract-address=${cfg.auctionContractAddress}`,
    `--auctioneer-server.redis-url=redis://host.docker.internal:${REDIS_HOST_PORT}`,
    `--auctioneer-server.sequencer-endpoint=${cfg.sequencerRpcEndpoint}`,
    `--auctioneer-server.use-redis-coordinator=false`,
    // Nitro's wallet config wants the key WITHOUT the "0x" prefix.
    `--auctioneer-server.wallet.private-key=${cfg.auctioneerPrivateKey.replace(/^0x/, '')}`,
    `--auctioneer-server.db-directory=/home/user/auctioneer-db`,
    `--bid-validator.enable=false`,
    `--http.addr=0.0.0.0`,
    `--http.port=9374`,
  ].join(' ');
  const auctioneerCmd = `mkdir -p /home/user/auctioneer-db && exec /usr/local/bin/autonomous-auctioneer ${auctioneerArgs}`;
  const auctioneerId = await runDocker([
    'run -d',
    `--name ${AUCTIONEER_CONTAINER}`,
    `-p ${AUCTIONEER_HTTP_HOST_PORT}:9374`,
    `--add-host=host.docker.internal:host-gateway`,
    `--entrypoint sh`,
    cfg.auctioneerImage,
    `-c`,
    `'${auctioneerCmd}'`,
  ]);
  await waitForLogLine(AUCTIONEER_CONTAINER, /Auctioneer started|consuming|consumer/, 30_000);
  log.success('auctioneer-server up');

  return {
    redisContainerId: redisId,
    bidValidatorContainerId: bidValidatorId,
    auctioneerContainerId: auctioneerId,
    redisHostUrl: `redis://host.docker.internal:${REDIS_HOST_PORT}`,
    bidValidatorHostUrl: `http://localhost:${BID_VALIDATOR_HOST_PORT}`,
  };
}

export async function stopTimeboostServices(): Promise<void> {
  for (const name of [AUCTIONEER_CONTAINER, BID_VALIDATOR_CONTAINER, REDIS_CONTAINER]) {
    try {
      await quietDockerCommand(`rm -f ${name}`);
    } catch {
      // container probably wasn't running — ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runDocker(args: string[]): Promise<string> {
  const r = (await quietDockerCommand(args.join(' '))) as { raw?: string };
  return (r?.raw ?? '').trim();
}

/** Poll `probe` every 500ms until it returns true or `timeoutMs` elapses. */
async function pollUntil(probe: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return true;
    } catch {
      // not ready yet
    }
    await sleep(500);
  }
  return false;
}

async function waitForRedis(timeoutMs = 15_000): Promise<void> {
  const ready = await pollUntil(async () => {
    const r = (await quietDockerCommand(`exec ${REDIS_CONTAINER} redis-cli PING`)) as { raw?: string };
    return !!r?.raw?.includes('PONG');
  }, timeoutMs);
  if (!ready) throw new Error(`Redis did not become ready within ${timeoutMs}ms`);
}

/**
 * Soft readiness gate on container logs: we don't fail the demo if the regex
 * never matches — the caller proceeds and lets the next operation surface
 * real failures.
 */
async function waitForLogLine(container: string, pattern: RegExp, timeoutMs: number): Promise<void> {
  const ready = await pollUntil(async () => {
    const r = (await quietDockerCommand(`logs --tail 200 ${container}`)) as { raw?: string };
    return !!r?.raw && pattern.test(r.raw);
  }, timeoutMs);
  if (!ready)
    log.warn(`Container ${container} did not log a line matching ${pattern} within ${timeoutMs}ms — continuing anyway`);
}
