/**
 * Phase 5b — capture auction events as they're emitted by the
 * ExpressLaneAuction contract. We poll `eth_getLogs` over a sliding window
 * (cheaper than `watchContractEvent` and works on any RPC).
 *
 * Events of interest:
 *   - AuctionResolved(...)
 *   - SetExpressLaneController(...)
 *   - Deposit(...)
 *
 * Output is a stream of `AuctionEvent` records the demo runner accumulates
 * for the HTML report.
 */

import { type Address, type Hash, type PublicClient, decodeEventLog, parseAbi } from 'viem';
import { expressLaneAuctionArtifact } from './abis.js';
import type { AuctionEvent } from './types.js';

let log = {
  info: (m: string) => console.log('ℹ', m),
  warn: (m: string) => console.log('⚠', m),
  event: (m: string) => console.log('•', m),
};

export function setAuctionMonitorLogger(l: typeof log): void {
  log = l;
}

export interface AuctionMonitorHandle {
  events: AuctionEvent[];
  stop: () => void;
}

/**
 * Start a polling watcher. Returns immediately with a handle the caller can
 * read from + stop. Polls every `pollIntervalMs` (default 750ms — half a
 * round at 20s round duration is plenty).
 */
export function startAuctionMonitor(
  publicClient: PublicClient,
  auctionAddress: Address,
  options: { pollIntervalMs?: number; fromBlock?: bigint } = {},
): AuctionMonitorHandle {
  const events: AuctionEvent[] = [];
  let stopped = false;
  let lastBlockSeen: bigint | undefined = options.fromBlock;
  const interval = options.pollIntervalMs ?? 750;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const head = await publicClient.getBlockNumber();
      const fromBlock = lastBlockSeen ?? head;
      if (fromBlock <= head) {
        const logs = await publicClient.getLogs({
          address: auctionAddress,
          fromBlock,
          toBlock: head,
        });
        for (const l of logs) {
          const decoded = tryDecode(l);
          if (!decoded) continue;
          events.push(decoded);
          log.event(`[${decoded.kind}] ${decoded.description}`);
        }
        lastBlockSeen = head + 1n;
      }
    } catch (e) {
      log.warn(`auction monitor poll error: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!stopped) setTimeout(tick, interval);
  };

  setTimeout(tick, 0);

  return {
    events,
    stop: () => {
      stopped = true;
    },
  };
}

function tryDecode(log_: {
  address: Address;
  data: `0x${string}`;
  topics: `0x${string}`[];
  blockNumber: bigint;
  transactionHash: Hash | null;
}): AuctionEvent | null {
  try {
    const decoded = decodeEventLog({
      abi: expressLaneAuctionArtifact.abi,
      data: log_.data,
      topics: log_.topics as never,
    });

    const kind = mapEventKind(decoded.eventName);
    const description = describeEvent(decoded.eventName, decoded.args as Record<string, unknown>);
    return {
      blockNumber: log_.blockNumber,
      txHash: (log_.transactionHash ?? '0x0') as Hash,
      kind,
      description,
      raw: decoded.args as Record<string, unknown>,
    };
  } catch {
    return null;
  }
}

function mapEventKind(name: string): AuctionEvent['kind'] {
  if (name === 'AuctionResolved') return 'AuctionResolved';
  if (name === 'SetExpressLaneController') return 'SetExpressLaneController';
  if (name === 'Deposit') return 'Deposit';
  return 'Other';
}

function describeEvent(name: string, args: Record<string, unknown>): string {
  // Best-effort pretty-print. We avoid hard dependencies on specific arg
  // names so a rename in nitro-contracts doesn't break the demo.
  if (name === 'AuctionResolved') {
    const round = args.round ?? args._round ?? '?';
    const winner = args.firstPriceBidder ?? args.winner ?? args.expressLaneController ?? '?';
    const second = args.secondPriceAmount ?? args.amount ?? '?';
    return `round=${round} winner=${winner} secondPrice=${second}`;
  }
  if (name === 'SetExpressLaneController') {
    const round = args.round ?? '?';
    const controller = args.newExpressLaneController ?? args.expressLaneController ?? '?';
    return `round=${round} controller=${controller}`;
  }
  if (name === 'Deposit') {
    const account = args.account ?? args.bidder ?? '?';
    const amount = args.amount ?? '?';
    return `account=${account} amount=${amount}`;
  }
  return JSON.stringify(args, jsonReplacer);
}

function jsonReplacer(_key: string, v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  return v;
}

// Suppress unused-import warning for parseAbi (kept available for future use).
void parseAbi;
