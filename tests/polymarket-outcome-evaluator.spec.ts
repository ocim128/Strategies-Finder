/**
 * tests/polymarket-outcome-evaluator.spec.ts
 *
 * Tests for:
 * 1. Outcome row timestamp normalisation
 * 2. buy → yes, sell → no mapping
 * 3. No-lookahead: signal on bar i → event at bar i+1 time
 * 4. Last-bar signal is ignored when no bar i+1 exists
 * 5. Missing outcome row is counted, not silently dropped
 * 6. Duplicate signals targeting the same event are handled deterministically
 * 7. Prepared-data and normal execute produce identical evaluator results
 * 8. Multi-trade metrics are based on executed trades, not raw signal count
 * 9. Missing rows do not dilute directional win rates
 *
 * Run standalone:
 *   npx esno tests/polymarket-outcome-evaluator.spec.ts
 */

import { evaluatePolymarketOutcomes } from "../lib/polymarket-outcome-evaluator";
import { parseTimeToUnixSeconds } from "../lib/time-normalization";
import type { OHLCVData, Strategy, Signal } from "../lib/types/strategies";
import type { PolymarketOutcomeRow } from "../lib/types/polymarket-outcomes";

// ─── Helpers ──────────────────────────────────────────────────────────────

let testCount = 0;
let passCount = 0;
let failCount = 0;

function ok(cond: boolean, label: string): void {
    testCount++;
    if (cond) {
        passCount++;
        console.log(`  ✓ ${label}`);
    } else {
        failCount++;
        console.error(`  ✗ ${label}`);
    }
}

function eq<T>(a: T, b: T, label: string): void {
    const same = JSON.stringify(a) === JSON.stringify(b);
    if (!same) console.error(`    Expected: ${JSON.stringify(b)}\n    Got:      ${JSON.stringify(a)}`);
    ok(same, label);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────

/** Build a sequence of 5m BTC bars starting at t0 (unix-s). */
function makeBars(count: number, t0 = 1_700_000_000, intervalSec = 300): OHLCVData[] {
    return Array.from({ length: count }, (_, i) => ({
        time: (t0 + i * intervalSec) as OHLCVData['time'],
        open: 30000, high: 30100, low: 29900, close: 30050, volume: 100,
    }));
}

/** Build an outcome row whose event_start_ts matches the given bar time. */
function makeOutcomeRow(barTime: number, resolvedUp: 0 | 1): PolymarketOutcomeRow {
    return {
        series_id: "10684",
        event_slug: `btc-up-or-down-${barTime}`,
        market_slug: "",
        interval: "5m",
        event_start_ts: barTime,
        event_end_ts: barTime + 300,
        yes_token_id: "yes-tok",
        no_token_id: "no-tok",
        yes_open_price: 0.5,
        yes_entry_minute_1_price: 0.51,
        yes_entry_minute_2_price: 0.52,
        yes_entry_minute_3_price: 0.53,
        yes_entry_minute_4_price: 0.54,
        resolved_outcome_up: resolvedUp,
        resolution_source: "outcomePrices",
        updated_at: Math.floor(Date.now() / 1000),
    };
}

/** Basic strategy that emits a fixed set of signals. */
function makeFixedStrategy(signals: Signal[]): Strategy {
    return {
        name: "FixedStrategy",
        description: "Test fixture",
        defaultParams: {},
        paramLabels: {},
        execute: () => signals,
    };
}

// ─── 1. Timestamp normalisation ───────────────────────────────────────────

console.log("\n[1] Timestamp normalisation");
{
    ok(parseTimeToUnixSeconds(1_700_000_000) === 1_700_000_000, "unix-s passthrough");
    ok(parseTimeToUnixSeconds(1_700_000_000_000) === 1_700_000_000, "unix-ms → unix-s");
    ok(parseTimeToUnixSeconds("1700000000") === 1_700_000_000, "string numeric → unix-s");
    ok(parseTimeToUnixSeconds("2023-11-14T22:13:20.000Z") === 1_700_000_000, "ISO string → unix-s");
    ok(parseTimeToUnixSeconds(null) === null, "null → null");
    ok(parseTimeToUnixSeconds(undefined) === null, "undefined → null");
}

// ─── 2. Signal direction mapping ──────────────────────────────────────────

console.log("\n[2] Signal direction → prediction mapping");
{
    const T0 = 1_700_000_000;
    const bars = makeBars(3, T0);
    // bar0=T0, bar1=T0+300, bar2=T0+600
    // Signal on bar0 with buy → predicts YES at T0+300
    const buySignal: Signal = { time: bars[0].time, type: 'buy', price: 30000, barIndex: 0 };
    const outcomes = [makeOutcomeRow(T0 + 300, 1)]; // UP → win for buy
    const r = evaluatePolymarketOutcomes(bars, makeFixedStrategy([buySignal]), {}, outcomes);

    eq(r.predictionsTaken, 1, "one prediction taken for buy");
    eq(r.rows[0]?.prediction, "yes", "buy maps to yes");
    eq(r.rows[0]?.isWin, true, "buy+UP=win");
    eq(r.wins, 1, "wins=1");
    eq(r.losses, 0, "losses=0");

    // sell → no, outcome DOWN → win
    const sellSignal: Signal = { time: bars[0].time, type: 'sell', price: 30000, barIndex: 0 };
    const outcomes2 = [makeOutcomeRow(T0 + 300, 0)]; // DOWN → win for sell
    const r2 = evaluatePolymarketOutcomes(bars, makeFixedStrategy([sellSignal]), {}, outcomes2);

    eq(r2.rows[0]?.prediction, "no", "sell maps to no");
    eq(r2.rows[0]?.isWin, true, "sell+DOWN=win");
}

// ─── 3. No-lookahead: signal on bar i → event at bar i+1 time ─────────────

console.log("\n[3] No-lookahead alignment");
{
    const T0 = 1_700_010_000;
    const bars = makeBars(4, T0); // T0, T0+300, T0+600, T0+900

    // Signal on bar 1 (T0+300) → should target bar 2 open time (T0+600)
    const sig: Signal = { time: bars[1].time, type: 'buy', price: 30000, barIndex: 1 };

    // Row whose event_start_ts = T0+600 (bar 2 time)
    const rightRow = makeOutcomeRow(T0 + 600, 1);
    // Row whose event_start_ts = T0+300 (bar 1 time) — should NOT be used
    const wrongRow = makeOutcomeRow(T0 + 300, 0);

    const result = evaluatePolymarketOutcomes(bars, makeFixedStrategy([sig]), {}, [rightRow, wrongRow]);

    ok(result.rows[0]?.eventStartTs === T0 + 600, "signal on bar 1 evaluates T0+600 (bar 2)");
    ok(result.rows[0]?.isWin === true, "resolves against correct row (UP=win)");
    eq(result.wins, 1, "1 win");
}

// ─── 4. Last-bar signal is ignored ───────────────────────────────────────

console.log("\n[4] Last-bar signal is ignored");
{
    const T0 = 1_700_020_000;
    const bars = makeBars(3, T0); // bars 0,1,2

    // Signal on bar 2 (last bar) — no bar 3 exists
    const lastBarSig: Signal = { time: bars[2].time, type: 'buy', price: 30000, barIndex: 2 };
    // Also a valid signal on bar 0 for comparison
    const validSig: Signal = { time: bars[0].time, type: 'buy', price: 30000, barIndex: 0 };

    const outcomes = [makeOutcomeRow(T0 + 300, 1)]; // bar1 time
    const r1 = evaluatePolymarketOutcomes(bars, makeFixedStrategy([lastBarSig]), {}, outcomes);

    eq(r1.predictionsTaken, 0, "last-bar signal: predictionsTaken=0");
    eq(r1.ignoredSignals, 1, "last-bar signal: ignoredSignals=1");
    eq(r1.wins, 0, "last-bar signal: wins=0");

    // Confirm valid signal on bar 0 still works
    const r2 = evaluatePolymarketOutcomes(bars, makeFixedStrategy([validSig]), {}, outcomes);
    eq(r2.predictionsTaken, 1, "bar0 signal: predictionsTaken=1");
}

// ─── 5. Missing outcome row is counted, not silently dropped ──────────────

console.log("\n[5] Missing outcome row is counted");
{
    const T0 = 1_700_030_000;
    const bars = makeBars(3, T0);
    const sig: Signal = { time: bars[0].time, type: 'buy', price: 30000, barIndex: 0 };

    // No outcome row for bar1 time (T0+300)
    const r = evaluatePolymarketOutcomes(bars, makeFixedStrategy([sig]), {}, []);

    eq(r.predictionsTaken, 1, "prediction still taken");
    eq(r.scoredPredictions, 0, "missing row: scoredPredictions=0");
    eq(r.missingOutcomeRows, 1, "missing outcome row counted");
    eq(r.wins, 0, "wins=0 (no row to score against)");
    eq(r.losses, 0, "losses=0 (no row to score against)");
}

// ─── 6. Duplicate signals targeting the same event: first wins ────────────

console.log("\n[6] Duplicate signals targeting same event");
{
    const T0 = 1_700_040_000;
    const bars = makeBars(5, T0); // 0..4

    // bar0 and bar1 both signal; bar0+1=bar1 time, bar1+1=bar2 time → different targets
    // so create a case where two bars have the same next-bar (impossible in practice, but
    // we test the dedup via constructed identical barIndex).

    // Use two signals with barIndex=1 (same bar) but different types — only the first (buy) wins.
    const sig1: Signal = { time: bars[1].time, type: 'buy',  price: 30000, barIndex: 1 };
    const sig2: Signal = { time: bars[1].time, type: 'sell', price: 30000, barIndex: 1 };

    const targetTs = T0 + 600; // bar2 time
    const row = makeOutcomeRow(targetTs, 1); // UP

    const r = evaluatePolymarketOutcomes(bars, makeFixedStrategy([sig1, sig2]), {}, [row]);

    eq(r.predictionsTaken, 1, "only one prediction per event");
    eq(r.rows[0]?.prediction, "yes", "first signal (buy→yes) wins dedup");
    eq(r.ignoredSignals, 1, "second signal for same event is ignored");
}

// ─── 7. Prepared-data path produces identical results ────────────────────

console.log("\n[7] Prepared-data path produces identical evaluator results");
{
    const T0 = 1_700_050_000;
    const bars = makeBars(4, T0);
    const sig: Signal = { time: bars[0].time, type: 'buy', price: 30000, barIndex: 0 };
    const outcomes = [makeOutcomeRow(T0 + 300, 1)];

    let prepareCalled = false;
    let executePreparedCalled = false;

    const preparedStrategy: Strategy = {
        name: "PreparedStrategy",
        description: "Has prepareFinderData",
        defaultParams: {},
        paramLabels: {},
        execute: () => [sig],
        prepareFinderData: (_data) => {
            prepareCalled = true;
            return { preparedMarker: true };
        },
        executePrepared: (_prepared, _params, _data) => {
            executePreparedCalled = true;
            return [sig];
        },
    };

    const normalResult   = evaluatePolymarketOutcomes(bars, preparedStrategy, {}, outcomes, { usePreparedData: false });
    const preparedResult = evaluatePolymarketOutcomes(bars, preparedStrategy, {}, outcomes, { usePreparedData: true  });

    ok(prepareCalled, "prepareFinderData was called");
    ok(executePreparedCalled, "executePrepared was called");
    eq(normalResult.wins,  preparedResult.wins,  "wins identical between normal and prepared path");
    eq(normalResult.losses, preparedResult.losses, "losses identical");
    eq(normalResult.winRate, preparedResult.winRate, "winRate identical");
    eq(normalResult.rows.length, preparedResult.rows.length, "row count identical");
}

// ─── 8. Additional: winRate / coverage / baseline maths ──────────────────

console.log("\n[8] Metrics: winRate, coverage, baseline rates");
{
    const T0 = 1_700_060_000;
    const bars = makeBars(8, T0); // bars 0..7
    // Signals on bars 0,2,4 become next_open trades on bars 1,3,5.
    const sigs: Signal[] = [
        { time: bars[0].time, type: 'buy',  price: 30000, barIndex: 0 },  // execution @ T0+300
        { time: bars[2].time, type: 'buy',  price: 30000, barIndex: 2 },  // execution @ T0+900
        { time: bars[4].time, type: 'sell', price: 30000, barIndex: 4 },  // execution @ T0+1500
    ];
    const outcomes = [
        makeOutcomeRow(T0 + 300, 1),  // UP
        makeOutcomeRow(T0 + 900, 0),  // DOWN
        makeOutcomeRow(T0 + 1500, 0), // DOWN
        makeOutcomeRow(T0 + 1800, 1), // UP – no executed trade → skip
    ];
    const r = evaluatePolymarketOutcomes(bars, makeFixedStrategy(sigs), {}, outcomes, {
        backtestSettings: {
            riskMaxHoldEnabled: true,
            riskMaxHoldBars: 1,
        },
    });

    eq(r.evaluatedEvents, 4, "4 events in outcomes");
    eq(r.predictionsTaken, 3, "3 predictions taken");
    eq(r.scoredPredictions, 3, "3 predictions scored");
    eq(r.skips, 1, "1 skip (event with no signal)");
    eq(r.wins, 2, "2 wins");
    eq(r.losses, 1, "1 loss");
    ok(Math.abs(r.winRate - 2 / 3) < 1e-9, `winRate=2/3 (got ${r.winRate})`);
    ok(Math.abs(r.coverage - 3 / 4) < 1e-9, `coverage=3/4 (got ${r.coverage})`);
    // 2 UP out of 4 events → alwaysYes baseline = 0.5
    ok(Math.abs(r.alwaysYesBaselineWinRate - 0.5) < 1e-9, `alwaysYes=0.5 (got ${r.alwaysYesBaselineWinRate})`);
    ok(Math.abs(r.alwaysNoBaselineWinRate - 0.5) < 1e-9, `alwaysNo=0.5 (got ${r.alwaysNoBaselineWinRate})`);
}

// â”€â”€â”€ 9. Missing rows do not inflate coverage above 100% â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

console.log("\n[9] Missing rows do not inflate coverage");
{
    const T0 = 1_700_070_000;
    const bars = makeBars(6, T0);
    const sigs: Signal[] = [
        { time: bars[0].time, type: 'buy', price: 30000, barIndex: 0 },
        { time: bars[2].time, type: 'buy', price: 30000, barIndex: 2 },
    ];
    const outcomes = [
        makeOutcomeRow(T0 + 300, 1),
    ];

    const r = evaluatePolymarketOutcomes(bars, makeFixedStrategy(sigs), {}, outcomes, {
        backtestSettings: {
            riskMaxHoldEnabled: true,
            riskMaxHoldBars: 1,
        },
    });

    eq(r.predictionsTaken, 2, "2 predictions taken");
    eq(r.scoredPredictions, 1, "only 1 prediction scored");
    eq(r.missingOutcomeRows, 1, "1 prediction missing outcome");
    ok(Math.abs(r.coverage - 1) < 1e-9, `coverage capped by scored predictions (got ${r.coverage})`);
    ok(Math.abs(r.longWinRate - 1) < 1e-9, `longWinRate uses scored longs only (got ${r.longWinRate})`);
}

// ─── Summary ─────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(60)}`);
console.log(`Tests: ${testCount}  Pass: ${passCount}  Fail: ${failCount}`);
if (failCount > 0) {
    console.error(`\n${failCount} test(s) FAILED`);
    process.exitCode = 1;
} else {
    console.log("\nAll tests passed ✓");
}
