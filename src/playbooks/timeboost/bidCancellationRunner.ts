/**
 * Optional demo (default off) — bid cancellation by overwrite.
 *
 * Timeboost has NO explicit "cancel bid" call: bids are sealed-bid commitments
 * held off-chain by the auctioneer, whose cache keeps ONE bid per express-lane
 * controller and overwrites on re-submission (nitro/timeboost/bid_cache.go).
 * So the canceller (Bob) bids HIGH naming Carol, the rival (Alice) bids MEDIUM,
 * then Bob re-bids LOW on the SAME controller — overwriting his entry. The
 * round resolution flips to Alice, which is the visible proof of cancellation.
 *
 * The cancel bid must stay >= the on-chain reserve (and <= deposit), otherwise
 * the bid-validator rejects it at submission and nothing is overwritten.
 */

import { type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { submitBid } from './bidder.js';
import { expressLaneAuctionArtifact } from './abis.js';
import {
  formatRoundLine,
  snapshotRound,
  waitUntilRound,
  waitForBiddingWindow,
  type RoundTiming,
} from './roundClock.js';
import { TimeboostRpcError } from './expressLaneRunner.js';
import type { AuctionEvent, BidCancellationRecord } from './types.js';
import { log, sleep } from './util.js';

const TOO_MANY_BIDS_SENTINEL = 'PER_ROUND_BID_LIMIT_REACHED';

export interface RunBidCancellationInput {
  publicClient: PublicClient;
  auctionAddress: Address;
  bidValidatorUrl: string;
  timing: RoundTiming;
  /** Canceller — bids high, then overwrites with a lower bid. */
  bidderKey: Hex;
  /** Rival — wins once the canceller downgrades. */
  rivalKey: Hex;
  /** Controller named in BOTH of the canceller's bids. Must differ from rivalController. */
  controller: Address;
  /** Controller named by the rival's bid. */
  rivalController: Address;
  /** Amounts (bidding-token wei); clamped to original > rival > cancelled >= reserve. */
  originalAmount: bigint;
  rivalAmount: bigint;
  cancelledToAmount: bigint;
  /** Also re-submit past the per-round cap to surface PER_ROUND_BID_LIMIT_REACHED. */
  testTooManyBids?: boolean;
}

/**
 * Drive one bid-cancellation round to completion. Assumes both bidders already
 * deposited into the auction contract (the full demo deposits on round 0), so
 * this only re-bids. The caller must have `auctionMonitor` running so the
 * resolution events show up in `events`.
 */
export async function runBidCancellationRound(
  input: RunBidCancellationInput,
  events: AuctionEvent[],
): Promise<BidCancellationRecord> {
  const bidder = privateKeyToAccount(input.bidderKey);

  // Clamp so the demo's ordering invariant survives a non-trivial on-chain
  // reserve: original > rival > cancelled >= reserve.
  const reservePrice = (await input.publicClient.readContract({
    address: input.auctionAddress,
    abi: expressLaneAuctionArtifact.abi,
    functionName: 'reservePrice',
  })) as bigint;
  const cancelledToAmount = input.cancelledToAmount > reservePrice ? input.cancelledToAmount : reservePrice;
  const rivalAmount = input.rivalAmount > cancelledToAmount ? input.rivalAmount : cancelledToAmount + 1n;
  const originalAmount = input.originalAmount > rivalAmount ? input.originalAmount : rivalAmount + 1n;

  // >3s headroom — this round fires several sequential bids.
  await waitForBiddingWindow(input.timing, 3);
  const snap = snapshotRound(input.timing);
  const bidForRound = BigInt(snap.current + 1);
  log.section(`Bid-cancellation round — bidding for round ${bidForRound}`);
  log.info(formatRoundLine(snap));
  log.info(
    `reserve=${reservePrice} | ${bidder.address.slice(0, 8)} HIGH=${originalAmount}→LOW=${cancelledToAmount} (controller ${input.controller.slice(0, 8)}), ` +
      `rival MED=${rivalAmount} (controller ${input.rivalController.slice(0, 8)})`,
  );

  const bid = (key: Hex, controller: Address, amount: bigint) =>
    submitBid({
      bidderPrivateKey: key,
      publicClient: input.publicClient,
      auctionAddress: input.auctionAddress,
      bidValidatorUrl: input.bidValidatorUrl,
      round: bidForRound,
      expressLaneController: controller,
      amount,
    });

  // Canceller leads, rival trails — then the canceller overwrites himself down.
  await bid(input.bidderKey, input.controller, originalAmount);
  log.info(`${bidder.address.slice(0, 8)} is leading with ${originalAmount}`);
  await bid(input.rivalKey, input.rivalController, rivalAmount);
  await bid(input.bidderKey, input.controller, cancelledToAmount);
  log.success(
    `${bidder.address.slice(0, 8)} re-bid ${cancelledToAmount} on the SAME controller — original bid overwritten (cancelled)`,
  );

  const tooManyBids = input.testTooManyBids
    ? await probeBidCap(() => bid(input.bidderKey, input.controller, cancelledToAmount))
    : undefined;

  log.info(`Waiting for auctioneer to resolve round ${bidForRound}...`);
  await waitUntilRound(input.timing, Number(bidForRound));
  await sleep(3000);

  const resolvedEvent = findEvent(events, 'AuctionResolved', bidForRound);
  const controllerSetEvent = findEvent(events, 'SetExpressLaneController', bidForRound);
  const observedWinner =
    ((controllerSetEvent?.raw?.newExpressLaneController ?? controllerSetEvent?.raw?.expressLaneController) as
      | Address
      | undefined) ?? null;
  const flipped = !!observedWinner && observedWinner.toLowerCase() === input.rivalController.toLowerCase();

  if (flipped) {
    log.success(
      `Cancellation flipped the round: controller is ${input.rivalController.slice(0, 8)} (rival), not ${input.controller.slice(0, 8)}`,
    );
  } else {
    log.warn(`Expected the rival controller to win after cancellation; observed=${observedWinner ?? '<none yet>'}`);
  }

  return {
    round: Number(bidForRound),
    bidder: bidder.address,
    controller: input.controller,
    rivalController: input.rivalController,
    reservePrice,
    originalAmount,
    cancelledToAmount,
    rivalAmount,
    observedWinner,
    flipped,
    resolvedEvent,
    controllerSetEvent,
    tooManyBids,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Re-submit until the validator's per-sender per-round cap (nitro default 5) rejects us. */
async function probeBidCap(bid: () => Promise<unknown>): Promise<NonNullable<BidCancellationRecord['tooManyBids']>> {
  let attempted = 0;
  let accepted = 0;
  while (attempted < 6) {
    attempted++;
    try {
      await bid();
      accepted++;
    } catch (e) {
      const msg = e instanceof TimeboostRpcError ? e.rpcMessage : e instanceof Error ? e.message : String(e);
      const rejected = msg.includes(TOO_MANY_BIDS_SENTINEL);
      if (rejected) log.success(`per-round bid cap reached after ${accepted} extra bid(s): ${msg}`);
      else log.warn(`unexpected rejection while probing bid cap: ${msg}`);
      return { attempted, accepted, rejected, errorMessage: msg };
    }
  }
  log.warn('per-round bid cap not reached within 6 attempts');
  return { attempted, accepted, rejected: false };
}

function findEvent(events: AuctionEvent[], kind: AuctionEvent['kind'], round: bigint): AuctionEvent | undefined {
  return events
    .slice()
    .reverse()
    .find((e) => e.kind === kind && e.raw?.round?.toString() === round.toString());
}
