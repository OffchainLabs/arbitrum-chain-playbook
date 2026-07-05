/**
 * Phase 5d — drive the auction lifecycle.
 *
 * Choreography per round:
 *   1. wait until we're in the bidding window (NOT in the auction-closed window)
 *   2. Alice + Bob each `submitBid()` for round N+1, naming DIFFERENT express
 *      lane controllers. This matters: the auctioneer's bid cache is keyed by
 *      `expressLaneController` (nitro/timeboost/bid_cache.go:27), so two bids
 *      naming the *same* controller would overwrite each other → only one bid
 *      survives → single-bid resolution at the reserve price. Distinct
 *      controllers keep both bids → multi-bid resolution at the second price.
 *      Bob (higher bid) names the winner controller (Carol); Alice names herself.
 *   3. (auctioneer-server runs the resolution at T-auctionClosingSeconds)
 *   4. wait until round N+1 starts; assert via auctionMonitor that
 *      AuctionResolved (two bids, second price) + SetExpressLaneController
 *      (controller=Carol) fired.
 *
 * Returns metadata each round so the demo runner can record it.
 */

import { type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { approveAndDeposit, submitBid, type SubmittedBid } from './bidder.js';
import { snapshotRound, formatRoundLine, waitUntilRound, type RoundTiming } from './roundClock.js';
import type { AuctionEvent } from './types.js';
import { log, sleep } from './util.js';

export interface RunOneAuctionInput {
  publicClient: PublicClient;
  auctionAddress: Address;
  biddingTokenAddress: Address;
  bidValidatorUrl: string;
  timing: RoundTiming;

  // Bidders (passed as private keys so the bidder can do raw-hash sign of Bid)
  aliceKey: Hex;
  bobKey: Hex;
  // Express lane controllers named in each bid. MUST be distinct (see header
  // comment) or the auctioneer collapses both bids into a single-bid auction.
  // Bob is the higher bidder, so `winnerController` is the address that ends up
  // controlling the express lane for the round.
  winnerController: Address; // named by Bob (the winning bid) — e.g. Carol
  loserController: Address; // named by Alice (the losing bid) — e.g. Alice herself

  // Bid amounts (units = bidding token wei). Bob bids higher → wins.
  aliceBidAmount: bigint;
  bobBidAmount: bigint;

  // Whether this bidder still needs to deposit (only do it once per process).
  aliceNeedsDeposit?: boolean;
  bobNeedsDeposit?: boolean;
  /** Per-bidder deposit amount; defaults to 5x their bid. */
  depositAmount?: bigint;
}

export interface AuctionRoundResult {
  bidForRound: number;
  bids: SubmittedBid[];
  resolvedAt?: AuctionEvent;
  controllerSetAt?: AuctionEvent;
}

/**
 * Drive a single auction round to completion. The caller is responsible for
 * having already started `auctionMonitor` so this function can read events
 * out of it.
 */
export async function runOneAuction(input: RunOneAuctionInput, events: AuctionEvent[]): Promise<AuctionRoundResult> {
  // -------------------------------------------------------------------------
  // 1. Optional deposits (first time only)
  // -------------------------------------------------------------------------
  if (input.aliceNeedsDeposit) {
    await approveAndDeposit({
      bidderPrivateKey: input.aliceKey,
      publicClient: input.publicClient,
      auctionAddress: input.auctionAddress,
      biddingTokenAddress: input.biddingTokenAddress,
      amount: input.depositAmount ?? input.aliceBidAmount * 5n,
    });
  }
  if (input.bobNeedsDeposit) {
    await approveAndDeposit({
      bidderPrivateKey: input.bobKey,
      publicClient: input.publicClient,
      auctionAddress: input.auctionAddress,
      biddingTokenAddress: input.biddingTokenAddress,
      amount: input.depositAmount ?? input.bobBidAmount * 5n,
    });
  }

  // -------------------------------------------------------------------------
  // 2. Wait for the bidding window of the *current* round to be open
  //    (i.e., not inside the auction-closing window). Bids are for round N+1.
  // -------------------------------------------------------------------------
  await waitForBiddingWindow(input.timing);
  const snap = snapshotRound(input.timing);
  const bidForRound = BigInt(snap.current + 1);
  log.section(`Bidding for round ${bidForRound}`);
  log.info(formatRoundLine(snap));

  // -------------------------------------------------------------------------
  // 3. Submit bids
  // -------------------------------------------------------------------------
  const bids: SubmittedBid[] = [];
  bids.push(
    await submitBid({
      bidderPrivateKey: input.aliceKey,
      publicClient: input.publicClient,
      auctionAddress: input.auctionAddress,
      bidValidatorUrl: input.bidValidatorUrl,
      round: bidForRound,
      expressLaneController: input.loserController,
      amount: input.aliceBidAmount,
    }),
  );
  bids.push(
    await submitBid({
      bidderPrivateKey: input.bobKey,
      publicClient: input.publicClient,
      auctionAddress: input.auctionAddress,
      bidValidatorUrl: input.bidValidatorUrl,
      round: bidForRound,
      expressLaneController: input.winnerController,
      amount: input.bobBidAmount,
    }),
  );

  // -------------------------------------------------------------------------
  // 4. Wait for the auction to resolve and the new round to start.
  // -------------------------------------------------------------------------
  log.info(`Waiting for auctioneer to resolve round ${bidForRound}...`);
  await waitUntilRound(input.timing, Number(bidForRound));
  // Give the chain a couple of seconds to surface the events.
  await sleep(3000);

  const resolvedAt = events
    .slice()
    .reverse()
    .find((e) => e.kind === 'AuctionResolved' && e.raw?.round?.toString() === bidForRound.toString());
  const controllerSetAt = events
    .slice()
    .reverse()
    .find((e) => e.kind === 'SetExpressLaneController' && e.raw?.round?.toString() === bidForRound.toString());

  if (resolvedAt) log.success(`AuctionResolved seen: ${resolvedAt.description}`);
  else log.warn(`AuctionResolved for round ${bidForRound} not observed yet.`);
  if (controllerSetAt) log.success(`SetExpressLaneController seen: ${controllerSetAt.description}`);
  else log.warn(`SetExpressLaneController for round ${bidForRound} not observed yet.`);

  return { bidForRound: Number(bidForRound), bids, resolvedAt, controllerSetAt };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForBiddingWindow(timing: RoundTiming): Promise<void> {
  for (;;) {
    const snap = snapshotRound(timing);
    if (!snap.insideAuctionClosingWindow && snap.secondsToAuctionClose > 1) {
      // Need at least 1s of headroom so the bid arrives before the auctioneer
      // closes the bidding window. This is a coarse guard; production code
      // should compute the validator's expected submission latency.
      return;
    }
    // We're inside the closing window; sleep until the next round opens.
    await sleep(Math.min(2000, snap.secondsToNextRound * 1000 + 100));
  }
}
