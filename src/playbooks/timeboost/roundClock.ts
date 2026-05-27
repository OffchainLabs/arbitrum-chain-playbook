/**
 * Phase 5c — round clock.
 *
 * Pure helpers + a non-rendering "wait until next round" utility. We do NOT
 * spawn a CLI animation here (v2 plan §0 #10): the rendering loop would fight
 * with StepTracker / ora. The demo runner can call these snapshot helpers
 * between StepTracker steps to print a status line.
 *
 * Mirrors nitro/timeboost/roundtiminginfo.go arithmetic.
 */

export interface RoundTiming {
  offsetTimestamp: number; // seconds
  roundDurationSeconds: number;
  auctionClosingSeconds: number;
  reserveSubmissionSeconds: number;
}

export interface RoundSnapshot {
  /** Round index (0-based). */
  current: number;
  /** Seconds elapsed within `current`. */
  elapsedInRound: number;
  /** Seconds until the next round starts. */
  secondsToNextRound: number;
  /**
   * Seconds until the auction for the *next* round closes — bids must arrive
   * at the bid-validator before this elapses, or they'll be rejected by the
   * auctioneer when it starts resolving.
   */
  secondsToAuctionClose: number;
  /**
   * True if we're inside the auction-closed window of the current round (the
   * last `auctionClosingSeconds` seconds before the next round starts).
   */
  insideAuctionClosingWindow: boolean;
}

export function snapshotRound(timing: RoundTiming, nowSec: number = Math.floor(Date.now() / 1000)): RoundSnapshot {
  const elapsedSinceOffset = Math.max(0, nowSec - timing.offsetTimestamp);
  const current = Math.floor(elapsedSinceOffset / timing.roundDurationSeconds);
  const elapsedInRound = elapsedSinceOffset - current * timing.roundDurationSeconds;
  const secondsToNextRound = timing.roundDurationSeconds - elapsedInRound;

  // The auctioneer rejects bids in the last `auctionClosingSeconds` seconds.
  const secondsToAuctionClose = secondsToNextRound - timing.auctionClosingSeconds;
  const insideAuctionClosingWindow = secondsToAuctionClose <= 0;

  return {
    current,
    elapsedInRound,
    secondsToNextRound,
    secondsToAuctionClose,
    insideAuctionClosingWindow,
  };
}

export function formatRoundLine(snap: RoundSnapshot): string {
  const ac = snap.insideAuctionClosingWindow ? 'auction CLOSED' : `auction closes in ${snap.secondsToAuctionClose}s`;
  return `Round ${snap.current} │ +${snap.elapsedInRound}s / next in ${snap.secondsToNextRound}s │ ${ac}`;
}

/**
 * Sleep until the start of round `target`. Logs nothing — caller decides
 * whether to render progress.
 */
export async function waitUntilRound(timing: RoundTiming, target: number, signal?: AbortSignal): Promise<void> {
  for (;;) {
    if (signal?.aborted) throw new Error('aborted');
    const snap = snapshotRound(timing);
    if (snap.current >= target) return;
    const sleepMs = Math.min(2000, snap.secondsToNextRound * 1000 + 50);
    await new Promise((r) => setTimeout(r, sleepMs));
  }
}
