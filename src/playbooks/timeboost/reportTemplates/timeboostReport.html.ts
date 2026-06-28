/**
 * Standalone HTML report renderer for the Timeboost playbook.
 *
 * Design choices:
 *  - Pure inline SVG. No chart.js / D3 / network fonts. Single file < 50KB
 *    so the report can be opened offline, attached to email, pasted into Notion.
 *  - Time axis uses client-side wall-clock (Date.now() captured at submit) as
 *    its origin. Block boundaries are reconstructed by `(blockNumber - first) * 250ms`
 *    because Arbitrum block.timestamp is second-granular — too coarse to render
 *    a 200ms artificial delay against. This caveat is shown in the report header.
 *  - Pure function, no I/O. The `reportGenerator.ts` wrapper handles writing.
 */

import type {
  AuctionEvent,
  BidCancellationRecord,
  ExperimentRecord,
  NoBidRoundRecord,
  ReportData,
  TxObservation,
  UnauthorizedAttemptRecord,
} from '../types.js';

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function renderReport(data: ReportData): string {
  const css = INLINE_CSS;
  const js = INLINE_JS;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Timeboost Auction Playbook Report — ${escapeHtml(data.generatedAtIso)}</title>
<style>${css}</style>
</head>
<body>
${renderHeader(data)}
${renderSummaryCards(data)}
${renderTimelineSection(data)}
${renderNoBidSection(data)}
${renderUnauthorizedSection(data)}
${renderBidCancellationSection(data)}
${renderEventFeed(data.events)}
${renderRawTable(data)}
${renderFooter()}
<script>${js}</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Header / summary
// ---------------------------------------------------------------------------

function renderHeader(d: ReportData): string {
  return `<header>
  <h1>Timeboost Auction Playbook Report</h1>
  <div class="meta">
    <span><b>Chain ID:</b> ${d.chainId}</span>
    <span><b>Generated:</b> ${escapeHtml(d.generatedAtIso)}</span>
    <span><b>Auction:</b> <code>${escapeHtml(d.auctionContract)}</code></span>
    <span><b>Bidding token:</b> <code>${escapeHtml(d.biddingToken)}</code></span>
  </div>
  <div class="meta">
    <span><b>Round:</b> ${d.roundDurationSeconds}s</span>
    <span><b>Auction closes:</b> T-${d.auctionClosingSeconds}s</span>
    <span><b>Reserve submission:</b> T-${d.reserveSubmissionSeconds}s</span>
    <span><b>Non-express delay:</b> ${d.nonExpressDelayMsec}ms</span>
  </div>
  <p class="caveat">
    This is a Timeboost <em>playbook demo</em>. The X axis below is pure client-side
    wall-clock time (milliseconds), with t=0 at the earliest send across all experiment
    pairs. Each bar runs from the <code>sendRawTransaction</code> /
    <code>timeboost_sendExpressLaneTransaction</code> call to the moment the client
    received its <code>eth_getTransactionReceipt</code> back. The authoritative signal
    is still the <code>timeboosted</code> field on each receipt (rendered as colour fill).
  </p>
</header>`;
}

function renderSummaryCards(d: ReportData): string {
  const s = d.summary;
  return `<section class="cards">
  ${card('Pairs run', String(s.totalExperiments))}
  ${card(
    'Express timeboosted',
    `${s.expressTimeboostedCount} / ${s.totalExperiments}`,
    s.expressTimeboostedCount === s.totalExperiments ? 'good' : 'bad',
  )}
  ${card(
    'Normal timeboosted',
    `${s.normalTimeboostedCount} / ${s.totalExperiments}`,
    s.normalTimeboostedCount === 0 ? 'good' : 'bad',
  )}
  ${card('Cross-block normal', `${s.crossBlockNormalCount} / ${s.totalExperiments}`)}
  ${card('Express median latency', `${s.expressMedianLatencyMs} ms`)}
  ${card('Normal median latency', `${s.normalMedianLatencyMs} ms`)}
  ${card('No-bid rounds', String(s.noBidRoundsObserved))}
  ${card(
    'Unauthorized rejected',
    `${s.unauthorizedRecognisedCount} / ${s.unauthorizedAttempts}`,
    s.unauthorizedRecognisedCount === s.unauthorizedAttempts ? 'good' : 'bad',
  )}
  ${
    s.bidCancellationRounds > 0
      ? card(
          'Bid cancellations flipped',
          `${s.bidCancellationFlippedCount} / ${s.bidCancellationRounds}`,
          s.bidCancellationFlippedCount === s.bidCancellationRounds ? 'good' : 'bad',
        )
      : ''
  }
</section>`;
}

function card(label: string, value: string, tone: 'good' | 'bad' | 'neutral' = 'neutral'): string {
  return `<div class="card ${tone}"><div class="value">${escapeHtml(value)}</div><div class="label">${escapeHtml(label)}</div></div>`;
}

// ---------------------------------------------------------------------------
// Timeline (the centrepiece)
// ---------------------------------------------------------------------------

function renderTimelineSection(d: ReportData): string {
  if (d.experiments.length === 0) {
    return `<section><h2>Timeline</h2><p class="empty">No experiments recorded.</p></section>`;
  }

  return `<section>
  <h2>Wall-clock latency — send → receipt</h2>
  <p>Each row is one experiment pair. The X axis is <b>client-side wall-clock time</b>
     (milliseconds), with t=0 at the earliest <code>sendRawTransaction</code> /
     <code>timeboost_sendExpressLaneTransaction</code> call across all experiments.
     Each bar runs from the moment the tx was submitted to the moment the
     client received its receipt back from the sequencer
     (<code>eth_getTransactionReceipt</code>). All times are pure wall-clock —
     no chain-side timestamps are mixed in. Express-lane bars are blue with a
     green outline when <code>timeboosted=true</code>; normal bars are orange
     when <code>timeboosted=false</code> (expected).</p>
  ${renderTimelineSvg(d.experiments)}
  <div class="legend">
    <span class="lg lg-el-good">express, timeboosted=true</span>
    <span class="lg lg-el-bad">express, timeboosted=false (unexpected)</span>
    <span class="lg lg-no-norm">normal, timeboosted=false (expected)</span>
    <span class="lg lg-no-bad">normal, timeboosted=true (unexpected)</span>
  </div>
</section>`;
}

function renderTimelineSvg(experiments: ExperimentRecord[]): string {
  // Pure wall-clock X axis. Both endpoints (sentAtMs, receiptAtMs) are taken
  // from Date.now() in the experiment recorder — no chain-side timestamps.
  // This avoids the ambiguity we hit when mixing client clock with
  // second-granular Arbitrum block timestamps.
  const allObs: TxObservation[] = experiments.flatMap((e) => [e.expressLane, e.normal]);
  const minSent = Math.min(...allObs.map((o) => o.sentAtMs));
  const maxReceipt = Math.max(...allObs.map((o) => o.receiptAtMs ?? o.sentAtMs));
  const totalMs = Math.max(maxReceipt - minSent, 100);

  const W = 880;
  const ROW_H = 48;
  const PAD_L = 60;
  const PAD_R = 110; // room for the "(N latency_ms)" label at the right end
  const PAD_T = 24;
  const PAD_B = 32;
  const innerW = W - PAD_L - PAD_R;
  const innerH = experiments.length * ROW_H;
  const H = innerH + PAD_T + PAD_B;

  const xScale = (ms: number): number => PAD_L + ((ms - minSent) / totalMs) * innerW;

  // Vertical gridlines every 200ms (the configured non-express delay) to
  // give the eye a unit to compare against.
  const grid: string[] = [];
  for (let t = 0; t <= totalMs; t += 200) {
    const x = xScale(minSent + t);
    grid.push(`<line x1="${x}" x2="${x}" y1="${PAD_T}" y2="${PAD_T + innerH}" class="time-grid" />`);
    grid.push(`<text x="${x}" y="${PAD_T + innerH + 14}" class="time-label">${t}ms</text>`);
  }

  const rows: string[] = experiments.map((e, i) => {
    const yEl = PAD_T + i * ROW_H + ROW_H / 3;
    const yNo = PAD_T + i * ROW_H + (ROW_H * 2) / 3;
    const elClass = elClassFor(e.expressLane);
    const noClass = noClassFor(e.normal);
    const elTip = encodeTooltip(e.expressLane, 'express', e);
    const noTip = encodeTooltip(e.normal, 'normal', e);

    const elX0 = xScale(e.expressLane.sentAtMs);
    const elX1 = xScale(e.expressLane.receiptAtMs ?? e.expressLane.sentAtMs);
    const noX0 = xScale(e.normal.sentAtMs);
    const noX1 = xScale(e.normal.receiptAtMs ?? e.normal.sentAtMs);
    const elDur = (e.expressLane.receiptAtMs ?? e.expressLane.sentAtMs) - e.expressLane.sentAtMs;
    const noDur = (e.normal.receiptAtMs ?? e.normal.sentAtMs) - e.normal.sentAtMs;

    return `
    <g class="row">
      <text x="${PAD_L - 8}" y="${yEl + 4}" class="lane-label">#${i + 1} EL</text>
      <text x="${PAD_L - 8}" y="${yNo + 4}" class="lane-label">#${i + 1} N</text>
      <line x1="${elX0}" y1="${yEl}" x2="${elX1}" y2="${yEl}" class="bar ${elClass}" data-tip="${elTip}" />
      <circle cx="${elX0}" cy="${yEl}" r="3.5" class="dot-send ${elClass}" data-tip="${elTip}" />
      <circle cx="${elX1}" cy="${yEl}" r="4.5" class="dot-recv ${elClass}" data-tip="${elTip}" />
      <text x="${elX1 + 6}" y="${yEl + 4}" class="dur-label el">${elDur}ms</text>

      <line x1="${noX0}" y1="${yNo}" x2="${noX1}" y2="${yNo}" class="bar ${noClass}" data-tip="${noTip}" />
      <circle cx="${noX0}" cy="${yNo}" r="3.5" class="dot-send ${noClass}" data-tip="${noTip}" />
      <circle cx="${noX1}" cy="${yNo}" r="4.5" class="dot-recv ${noClass}" data-tip="${noTip}" />
      <text x="${noX1 + 6}" y="${yNo + 4}" class="dur-label no">${noDur}ms</text>
    </g>`;
  });

  return `<div class="timeline-wrap"><svg viewBox="0 0 ${W} ${H}" class="timeline-svg" xmlns="http://www.w3.org/2000/svg">
  ${grid.join('\n  ')}
  ${rows.join('\n')}
</svg><div id="tip" class="tip" hidden></div></div>`;
}

function elClassFor(o: TxObservation): string {
  if (o.timeboosted === true) return 'el-good';
  return 'el-bad';
}

function noClassFor(o: TxObservation): string {
  if (o.timeboosted === true) return 'no-bad'; // unexpected!
  return 'no-norm';
}

function encodeTooltip(o: TxObservation, lane: string, exp: ExperimentRecord): string {
  const dur = (o.receiptAtMs ?? o.sentAtMs) - o.sentAtMs;
  const lines = [
    `lane: ${lane}`,
    `round: ${o.round}`,
    `pair index: ${exp.index + 1}`,
    `tx: ${o.txHash}`,
    `sender: ${o.sender}`,
    `block: ${o.blockNumber}`,
    `tx index in block: ${o.txIndex}`,
    `timeboosted: ${o.timeboosted === null ? 'absent' : String(o.timeboosted)}`,
    `sentAt:    ${new Date(o.sentAtMs).toISOString()}`,
    `receiptAt: ${o.receiptAtMs ? new Date(o.receiptAtMs).toISOString() : '<not captured>'}`,
    `latency: ${dur}ms`,
  ];
  return escapeAttr(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// No-bid rounds
// ---------------------------------------------------------------------------

function renderNoBidSection(d: ReportData): string {
  if (d.noBidRounds.length === 0) {
    return `<section><h2>No-bid rounds</h2><p class="empty">None observed in this run.</p></section>`;
  }

  const rows = d.noBidRounds.map((r) => renderNoBidRound(r)).join('\n');
  return `<section>
  <h2>No-bid rounds (control)</h2>
  <p>In a no-bid round there is no express lane controller, so the 200ms artificial
     delay is not applied to anyone. Both txs below should have <code>timeboosted=false</code>
     or the field should be absent — and there should be no statistical ordering advantage.</p>
  ${rows}
</section>`;
}

function renderNoBidRound(r: NoBidRoundRecord): string {
  const items = r.observations
    .map(
      (o) =>
        `<li>tx <code>${escapeHtml(o.txHash)}</code> — block ${o.blockNumber}, idx ${o.txIndex}, timeboosted=${o.timeboosted === null ? 'absent' : String(o.timeboosted)}</li>`,
    )
    .join('');
  return `<div class="nobid">
    <div class="nobid-h">Round ${r.round} — started ${new Date(r.startedAtMs).toISOString()}</div>
    <ul>${items}</ul>
  </div>`;
}

// ---------------------------------------------------------------------------
// Unauthorized attempts
// ---------------------------------------------------------------------------

function renderUnauthorizedSection(d: ReportData): string {
  if (d.unauthorized.length === 0) {
    return `<section><h2>Unauthorized attempts</h2><p class="empty">None recorded.</p></section>`;
  }

  const rows = d.unauthorized.map((u) => renderUnauthorizedRow(u)).join('\n');
  return `<section>
  <h2>Unauthorized attempts (negative demo)</h2>
  <p>A non-controller submits to <code>timeboost_sendExpressLaneTransaction</code>;
     the sequencer is expected to reject with <code>NOT_EXPRESS_LANE_CONTROLLER</code>.
     This proves the sequencer is enforcing the controller right — without this signal,
     the audience cannot tell that the policy is active.</p>
  <table class="raw">
    <thead><tr><th>Attempt</th><th>Round</th><th>Sender</th><th>Recognised</th><th>Error</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function renderUnauthorizedRow(u: UnauthorizedAttemptRecord): string {
  const cls = u.recognised ? 'good' : 'bad';
  return `<tr class="${cls}">
    <td>${escapeHtml(new Date(u.attemptedAtMs).toISOString())}</td>
    <td>${u.round}</td>
    <td><code>${escapeHtml(u.attempterAddress)}</code></td>
    <td>${u.recognised ? '✓' : '✗'}</td>
    <td><code>${escapeHtml(u.errorMessage)}</code></td>
  </tr>`;
}

// ---------------------------------------------------------------------------
// Bid cancellation (optional demo)
// ---------------------------------------------------------------------------

function renderBidCancellationSection(d: ReportData): string {
  // Default-off: render nothing at all when the optional demo didn't run, so
  // baseline reports are byte-for-byte unaffected.
  if (d.bidCancellations.length === 0) return '';

  const rows = d.bidCancellations.map((b) => renderBidCancellationRow(b)).join('\n');
  return `<section>
  <h2>Bid cancellation (optional demo)</h2>
  <p>Timeboost has no explicit "cancel bid" call — bids are sealed-bid commitments
     held off-chain by the auctioneer. A bidder "cancels" by <b>re-submitting a lower
     bid that names the same express-lane controller</b>: the auctioneer keeps only one
     bid per controller (its cache is keyed by controller and overwrites on each add),
     so the lower re-bid replaces the higher one. Below, the canceller's high bid is
     overwritten down past a rival's bid, <b>flipping</b> which controller wins the round.</p>
  <table class="raw">
    <thead><tr>
      <th>Round</th><th>Canceller</th><th>Original →  re-bid</th><th>Rival bid</th>
      <th>Reserve</th><th>Observed winner</th><th>Flipped</th><th>Bid cap</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function renderBidCancellationRow(b: BidCancellationRecord): string {
  const cls = b.flipped ? 'good' : 'bad';
  const cap = b.tooManyBids
    ? b.tooManyBids.rejected
      ? `✓ capped (${escapeHtml(b.tooManyBids.errorMessage ?? '')})`
      : `not reached (${b.tooManyBids.accepted} extra)`
    : '—';
  return `<tr class="${cls}">
    <td>${b.round}</td>
    <td><code>${escapeHtml(b.bidder)}</code><br><span class="muted">controller <code>${escapeHtml(b.controller)}</code></span></td>
    <td>${b.originalAmount.toString()} → <b>${b.cancelledToAmount.toString()}</b></td>
    <td>${b.rivalAmount.toString()}<br><span class="muted">controller <code>${escapeHtml(b.rivalController)}</code></span></td>
    <td>${b.reservePrice.toString()}</td>
    <td><code>${escapeHtml(b.observedWinner ?? '<none>')}</code></td>
    <td>${b.flipped ? '✓' : '✗'}</td>
    <td>${escapeHtml(cap)}</td>
  </tr>`;
}

// ---------------------------------------------------------------------------
// Auction event feed
// ---------------------------------------------------------------------------

function renderEventFeed(events: AuctionEvent[]): string {
  if (events.length === 0) {
    return `<section><h2>Auction events</h2><p class="empty">No events captured.</p></section>`;
  }

  const rows = events
    .map(
      (e) => `<tr>
      <td>${e.blockNumber}</td>
      <td><span class="evt evt-${e.kind.toLowerCase()}">${e.kind}</span></td>
      <td>${escapeHtml(e.description)}</td>
      <td><code>${escapeHtml(e.txHash)}</code></td>
    </tr>`,
    )
    .join('\n');

  return `<section>
  <h2>Auction events</h2>
  <table class="raw">
    <thead><tr><th>Block</th><th>Kind</th><th>Description</th><th>Tx</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

// ---------------------------------------------------------------------------
// Raw data table (for verification / copy-paste)
// ---------------------------------------------------------------------------

function renderRawTable(d: ReportData): string {
  const rows = d.experiments.flatMap((e) => [rowFor(e, e.expressLane, 'express'), rowFor(e, e.normal, 'normal')]);
  return `<section>
  <h2>Raw experiment data</h2>
  <table class="raw">
    <thead><tr><th>Pair</th><th>Lane</th><th>Round</th><th>Block</th><th>Idx</th><th>timeboosted</th><th>Sent</th><th>Tx</th></tr></thead>
    <tbody>${rows.join('\n')}</tbody>
  </table>
</section>`;
}

function rowFor(e: ExperimentRecord, o: TxObservation, lane: string): string {
  return `<tr>
    <td>#${e.index + 1}</td>
    <td>${lane}</td>
    <td>${o.round}</td>
    <td>${o.blockNumber}</td>
    <td>${o.txIndex}</td>
    <td>${o.timeboosted === null ? 'absent' : String(o.timeboosted)}</td>
    <td>${new Date(o.sentAtMs).toISOString()}</td>
    <td><code>${escapeHtml(o.txHash)}</code></td>
  </tr>`;
}

function renderFooter(): string {
  return `<footer>
    <p>Generated by <code>arbitrum-chain-playbook</code> · Timeboost playbook · Phase 7 report.</p>
  </footer>`;
}

// ---------------------------------------------------------------------------
// Inline CSS / JS
// ---------------------------------------------------------------------------

const INLINE_CSS = `
:root {
  --fg: #1a1a1a; --muted: #666; --bg: #fff; --panel: #f7f7f8;
  --good: #137333; --bad: #c5221f; --warn: #b06000;
  --el: #1967d2; --no: #ea8600; --grid: #cfd2d7;
}
* { box-sizing: border-box; }
body {
  font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: var(--fg); background: var(--bg); margin: 0; padding: 0 24px 48px;
}
header { padding: 24px 0 16px; border-bottom: 1px solid var(--grid); }
header h1 { margin: 0 0 12px; font-size: 22px; }
.meta { display: flex; flex-wrap: wrap; gap: 18px; color: var(--muted); margin: 4px 0; font-size: 13px; }
.meta code { background: var(--panel); padding: 1px 5px; border-radius: 3px; }
.caveat { color: var(--muted); margin: 16px 0 0; font-size: 13px; max-width: 880px; }
section { margin: 28px 0; }
section h2 { margin: 0 0 8px; font-size: 17px; }
section p { margin: 4px 0 12px; color: var(--muted); max-width: 880px; }
.empty { color: var(--muted); font-style: italic; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; }
.card { background: var(--panel); padding: 12px; border-radius: 6px; border-left: 3px solid var(--grid); }
.card .value { font-size: 22px; font-weight: 600; }
.card .label { font-size: 12px; color: var(--muted); margin-top: 2px; }
.card.good { border-left-color: var(--good); }
.card.bad { border-left-color: var(--bad); }
.timeline-wrap { position: relative; overflow-x: auto; }
.timeline-svg { width: 100%; max-width: 1000px; height: auto; }
.lane-label { font: 10px/1 monospace; fill: var(--muted); text-anchor: end; }
.time-grid { stroke: var(--grid); stroke-dasharray: 3 3; stroke-width: 1; }
.time-label { font: 10px/1 monospace; fill: var(--muted); text-anchor: middle; }
.bar { stroke-width: 4; stroke-linecap: round; cursor: default; }
.bar.el-good { stroke: var(--el); }
.bar.el-bad  { stroke: var(--el); stroke-dasharray: 4 2; opacity: 0.6; }
.bar.no-norm { stroke: var(--no); }
.bar.no-bad  { stroke: var(--bad); stroke-dasharray: 4 2; }
.dot-send { fill: #fff; stroke-width: 2; }
.dot-send.el-good { stroke: var(--el); }
.dot-send.el-bad  { stroke: var(--bad); }
.dot-send.no-norm { stroke: var(--no); }
.dot-send.no-bad  { stroke: var(--bad); }
.dot-recv.el-good { fill: var(--el); stroke: var(--good); stroke-width: 2; }
.dot-recv.el-bad  { fill: var(--bad); stroke: var(--bad); }
.dot-recv.no-norm { fill: var(--no); stroke: var(--no); }
.dot-recv.no-bad  { fill: var(--bad); stroke: var(--bad); }
.dur-label { font: 10px/1 monospace; }
.dur-label.el { fill: var(--el); font-weight: 600; }
.dur-label.no { fill: var(--no); font-weight: 600; }
.legend { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 10px; font-size: 12px; color: var(--muted); }
.lg::before { content: ""; display: inline-block; width: 14px; height: 4px; margin-right: 6px; border-radius: 2px; vertical-align: middle; }
.lg-el-good::before { background: var(--el); }
.lg-el-bad::before { background: var(--el); opacity: 0.5; }
.lg-no-norm::before { background: var(--no); }
.lg-no-bad::before { background: var(--bad); }
.tip { position: absolute; background: #1a1a1a; color: #fff; padding: 6px 8px; border-radius: 4px; font: 11px/1.4 monospace; white-space: pre; pointer-events: none; z-index: 10; max-width: 380px; }
.nobid { background: var(--panel); padding: 10px 12px; border-radius: 6px; margin: 8px 0; }
.nobid-h { font-weight: 600; margin-bottom: 4px; }
.nobid ul { margin: 4px 0 0 18px; padding: 0; }
.nobid li { font: 12px/1.5 monospace; color: var(--muted); }
table.raw { border-collapse: collapse; width: 100%; font-size: 12px; }
table.raw th, table.raw td { padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--grid); }
table.raw th { background: var(--panel); font-weight: 600; }
table.raw tr.good td { color: var(--good); }
table.raw tr.bad  td { color: var(--bad); }
.evt { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 11px; font-weight: 600; }
.evt-auctionresolved          { background: #e6f4ea; color: var(--good); }
.evt-setexpresslanecontroller { background: #e8f0fe; color: var(--el); }
.evt-deposit                  { background: #fef7e0; color: var(--warn); }
.evt-other                    { background: var(--panel); color: var(--muted); }
footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid var(--grid); color: var(--muted); font-size: 12px; }
.muted { color: var(--muted); }
code { font-family: SFMono-Regular, Menlo, monospace; }
`;

const INLINE_JS = `
(function () {
  var tip = document.getElementById('tip');
  if (!tip) return;
  document.querySelectorAll('[data-tip]').forEach(function (el) {
    el.addEventListener('mouseenter', function (ev) {
      tip.textContent = el.getAttribute('data-tip') || '';
      tip.hidden = false;
    });
    el.addEventListener('mousemove', function (ev) {
      var wrap = el.closest('.timeline-wrap');
      if (!wrap) return;
      var rect = wrap.getBoundingClientRect();
      tip.style.left = (ev.clientX - rect.left + 12) + 'px';
      tip.style.top  = (ev.clientY - rect.top + 12) + 'px';
    });
    el.addEventListener('mouseleave', function () { tip.hidden = true; });
  });
})();
`;

// ---------------------------------------------------------------------------
// Escapers (used for both element body and attribute contexts)
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/\n/g, '&#10;');
}
