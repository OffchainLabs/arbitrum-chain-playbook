/**
 * Unit tests for the timeboost round clock arithmetic.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotRound, formatRoundLine, type RoundTiming } from '../../src/playbooks/timeboost/roundClock.js';

const timing: RoundTiming = {
  offsetTimestamp: 1_000_000,
  roundDurationSeconds: 20,
  auctionClosingSeconds: 5,
  reserveSubmissionSeconds: 3,
};

describe('snapshotRound', () => {
  test('start of round 0', () => {
    const s = snapshotRound(timing, 1_000_000);
    assert.equal(s.current, 0);
    assert.equal(s.elapsedInRound, 0);
    assert.equal(s.secondsToNextRound, 20);
    assert.equal(s.secondsToAuctionClose, 15);
    assert.equal(s.insideAuctionClosingWindow, false);
  });

  test('inside the auction closing window', () => {
    // 17s into round 0: 3s to next round, closing window is the last 5s
    const s = snapshotRound(timing, 1_000_017);
    assert.equal(s.current, 0);
    assert.equal(s.secondsToNextRound, 3);
    assert.equal(s.insideAuctionClosingWindow, true);
  });

  test('round index advances with duration', () => {
    const s = snapshotRound(timing, 1_000_000 + 20 * 7 + 4);
    assert.equal(s.current, 7);
    assert.equal(s.elapsedInRound, 4);
  });

  test('clock before offset clamps to round 0', () => {
    const s = snapshotRound(timing, 999_000);
    assert.equal(s.current, 0);
  });

  test('formatRoundLine mentions the round and closing state', () => {
    const open = formatRoundLine(snapshotRound(timing, 1_000_000));
    assert.match(open, /Round 0/);
    assert.match(open, /auction closes in/);
    const closed = formatRoundLine(snapshotRound(timing, 1_000_017));
    assert.match(closed, /auction CLOSED/);
  });
});
