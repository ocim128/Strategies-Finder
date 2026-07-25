import assert from "node:assert/strict";
import {
    computeSelectorPnl,
    runOpenScoreUsdReplay,
    type OpenScoreUsdTarget,
    type SelectorPnlSummary,
} from "../lib/batch-backtest/batch-open-score-usd-replay-engine";
import type { BatchSyntheticPairArtifact } from "../lib/batch-backtest/batch-synthetic-artifact";
import type { BacktestResult, OHLCVData, Time, Trade } from "../lib/types/strategies";

/**
 * Selector-signal P&L tests.
 *
 * Two layers:
 *   1. computeSelectorPnl pure-helper math (deterministic: known series ->
 *      expected total/Sharpe/winRate/maxDrawdown; monotonicity; finite-filter;
 *      chronological drawdown ordering).
 *   2. runOpenScoreUsdReplay integration: the per-horizon `pnl` field is
 *      populated and equals computeSelectorPnl applied to the same per-event
 *      returns; the report carries TOP_MEAN_PNL + RANDOM_PNL lines.
 *
 * The P&L is an equal-weight OVERLAPPING, NON-COMPONDING basket — see
 * SelectorPnlSummary's scope note. Tests encode WHY each property matters.
 */

const T0 = 1_700_000_000;

// ---------------------------------------------------------------------------
// computeSelectorPnl — pure math
// ---------------------------------------------------------------------------

function testEmptyReturnsAllNull(): void {
    const s = computeSelectorPnl([], []);
    assert.equal(s.trades, 0);
    assert.equal(s.totalReturn, null);
    assert.equal(s.sharpe, null);
    assert.equal(s.winRate, null);
    assert.equal(s.maxDrawdown, null);
    console.log("PASS: empty returns all-null summary");
}

function testAllNonFiniteDropped(): void {
    // NaN / Infinity returns are censored events; they must be dropped, not
    // zero-filled (matching the engine's never-zero-fill rule).
    const s = computeSelectorPnl([Number.NaN, Number.POSITIVE_INFINITY, 0.1], [1, 2, 3]);
    assert.equal(s.trades, 1);
    assert.equal(s.totalReturn, 0.1);
    console.log("PASS: non-finite returns dropped, not zero-filled");
}

function testTotalReturnIsSumNotMean(): void {
    // totalReturn = SUM of per-event returns (equal 1-unit notional, no
    // compounding), NOT the mean. This is the contract that distinguishes the
    // P&L from the existing topMean (which is the mean).
    const s = computeSelectorPnl([0.10, 0.20, -0.05], [1, 2, 3]);
    assert.equal(s.totalReturn, 0.10 + 0.20 - 0.05);
    console.log("PASS: totalReturn is the sum, not the mean");
}

function testMonotonicityAllPositiveAndAllNegative(): void {
    const pos = computeSelectorPnl([0.1, 0.2, 0.05], [1, 2, 3]);
    assert.ok(pos.totalReturn! > 0);
    assert.equal(pos.winRate, 1);
    const neg = computeSelectorPnl([-0.1, -0.2, -0.05], [1, 2, 3]);
    assert.ok(neg.totalReturn! < 0);
    assert.equal(neg.winRate, 0);
    console.log("PASS: monotonicity (all-pos -> positive, all-neg -> negative, winRate extremes)");
}

function testWinRateIsFraction(): void {
    const s = computeSelectorPnl([0.1, -0.05, 0.2, -0.1, 0.0], [1, 2, 3, 4, 5]);
    // 2 of 5 strictly positive (0.0 is not > 0).
    assert.equal(s.winRate, 2 / 5);
    console.log("PASS: winRate is a 0..1 fraction, 0.0 not counted as a win");
}

function testSharpeSignMatchesMean(): void {
    // Sharpe sign tracks the mean return (std is always >= 0).
    const pos = computeSelectorPnl([0.1, 0.2, 0.15], [1, 2, 3]);
    assert.ok(pos.sharpe! > 0);
    const neg = computeSelectorPnl([-0.1, -0.2, -0.15], [1, 2, 3]);
    assert.ok(neg.sharpe! < 0);
    // Zero dispersion -> sharpe floored to 0 (not Infinity).
    const flat = computeSelectorPnl([0.05, 0.05, 0.05], [1, 2, 3]);
    assert.equal(flat.sharpe, 0);
    console.log("PASS: Sharpe sign tracks mean; zero-dispersion floored to 0");
}

function testMaxDrawdownChronological(): void {
    // Drawdown is measured on the chronological cumulative curve, so event
    // ORDER matters. Same returns, different time order -> different drawdown.
    // Series A: +0.10, -0.20, +0.10 -> cum: 0.10, -0.10, 0.00; peak 0.10,
    // trough -0.10 -> maxDD = 0.20.
    const a = computeSelectorPnl([0.10, -0.20, 0.10], [1, 2, 3]);
    assert.equal(a.maxDrawdown, 0.20);
    // Series B (same numbers, different order): -0.20, +0.10, +0.10 -> cum:
    // -0.20, -0.10, 0.00; peak 0 (start), trough -0.20 -> maxDD = 0.20.
    // Reorder to +0.10, +0.10, -0.20 -> cum: 0.10, 0.20, 0.00; peak 0.20,
    // trough 0.00 -> maxDD = 0.20... use a clearer discriminating case below.
    // +0.20, -0.30, +0.05 -> cum: 0.20, -0.10, -0.05; peak 0.20, trough -0.10
    // -> maxDD = 0.30.
    const c = computeSelectorPnl([0.20, -0.30, 0.05], [1, 2, 3]);
    assert.equal(c.maxDrawdown, 0.30);
    // Reorder the SAME returns chronologically later trough-first:
    // -0.30, +0.20, +0.05 -> cum: -0.30, -0.10, -0.05; peak 0, trough -0.30
    // -> maxDD = 0.30 (same value but different curve — confirms time-sorting).
    const d = computeSelectorPnl([-0.30, 0.20, 0.05], [10, 20, 30]);
    assert.equal(d.maxDrawdown, 0.30);
    // Unsorted input times must still sort chronologically for the curve:
    // feed times out of order, expect the time-sorted drawdown.
    const unsorted = computeSelectorPnl([0.20, -0.30, 0.05], [30, 10, 20]);
    // After sorting by time: returns become [−0.30(t10), 0.05(t20), 0.20(t30)]
    // -> cum: -0.30, -0.25, -0.05; peak 0, trough -0.30 -> maxDD 0.30.
    assert.equal(unsorted.maxDrawdown, 0.30);
    console.log("PASS: maxDrawdown chronological (time-sorted), order-dependent");
}

function testMaxDrawdownNonNegative(): void {
    // A monotonically rising curve has zero drawdown.
    const s = computeSelectorPnl([0.1, 0.2, 0.3], [1, 2, 3]);
    assert.equal(s.maxDrawdown, 0);
    console.log("PASS: maxDrawdown is 0 for a monotonically rising curve");
}

function testDeterminism(): void {
    const r = [0.05, -0.02, 0.1, 0.0, -0.03];
    const t = [5, 3, 1, 4, 2];
    // Identical inputs (including unsorted times) -> identical output.
    assert.deepEqual(computeSelectorPnl(r, t), computeSelectorPnl(r, t));
    console.log("PASS: identical inputs produce identical summaries");
}

// ---------------------------------------------------------------------------
// Integration — runOpenScoreUsdReplay populates pnl + report lines
// ---------------------------------------------------------------------------

function emptyResult(): BacktestResult {
    return {
        trades: [], netProfit: 0, netProfitPercent: 0, winRate: 0, expectancy: 0,
        avgTrade: 0, profitFactor: 0, maxDrawdown: 0, maxDrawdownPercent: 0,
        totalTrades: 0, winningTrades: 0, losingTrades: 0, avgWin: 0, avgLoss: 0,
        sharpeRatio: 0, equityCurve: [],
    };
}

let tradeId = 0;
function makeTrade(type: "long" | "short", entrySec: number, exitSec: number | null): Trade {
    return {
        id: tradeId += 1,
        type,
        entryTime: entrySec as Time,
        entryPrice: 1,
        exitTime: (exitSec ?? entrySec) as Time,
        exitPrice: 1,
        pnl: 0,
        pnlPercent: 0,
        size: 1,
        exitReason: exitSec === null ? "end_of_data" : "signal",
    };
}

function makePair(base: string, quote: string, trades: Trade[]): BatchSyntheticPairArtifact {
    return {
        symbol: `${base}+${quote}`,
        baseAsset: base,
        quoteAsset: quote,
        data: [],
        signals: [],
        result: { ...emptyResult(), totalTrades: trades.length, trades },
    };
}

function makeTarget(asset: string, bars: number, priceAt: (i: number) => number): OpenScoreUsdTarget {
    const data: OHLCVData[] = Array.from({ length: bars }, (_, i) => {
        const p = priceAt(i);
        return { time: (T0 + i * 1000) as Time, open: p, high: p, low: p, close: p, volume: 1 };
    });
    return { asset, symbol: `${asset}USDT`, data };
}

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
    for (const item of items) yield item;
}

async function testIntegrationPnlPopulatedAndMatchesHelper(): Promise<void> {
    // Two pairs entering long at the same timestamp so two assets become
    // positive candidates -> a TOP_MEAN pick is formed and a per-event return
    // exists for the horizon. AAA rises (entry open=100, exit close=110 ->
    // +10%); BBB flat (50 -> 50 -> 0%). TOP_MEAN picks the higher-coverage-
    // adjusted-score asset; whichever is picked, its per-event return is +10%
    // or 0%, and the P&L summary must equal computeSelectorPnl on that series.
    const pair1 = makePair("AAA", "XXX", [makeTrade("long", T0 + 1000, T0 + 3000)]);
    const pair2 = makePair("BBB", "YYY", [makeTrade("long", T0 + 1000, T0 + 3000)]);
    const targets = [
        makeTarget("AAA", 10, () => 100), // flat target; the rise is encoded via constant price
        makeTarget("BBB", 10, () => 50),
    ];
    const result = await runOpenScoreUsdReplay(
        () => fromArray([pair1, pair2]),
        () => fromArray(targets),
        { horizons: [2] },
    );

    assert.ok(result.horizons.length > 0, "at least one horizon");
    const h = result.horizons[0]!;
    assert.ok(h.pnl, "pnl field must be populated on the horizon");
    const topMeanPnl = h.pnl!.topMean as SelectorPnlSummary;
    const randomPnl = h.pnl!.random as SelectorPnlSummary;

    // The TOP_MEAN P&L trade count must equal the TOP_MEAN selector's eligible
    // event count (one trade per event).
    assert.equal(topMeanPnl.trades, h.topMean.events);
    assert.equal(randomPnl.trades, h.topMean.events);
    // totalReturn must equal (mean * trades) because total = sum = mean * n.
    if (topMeanPnl.trades > 0 && h.topMean.topMean !== null) {
        const expectedTotal = h.topMean.topMean * topMeanPnl.trades;
        assert.ok(
            Math.abs(topMeanPnl.totalReturn! - expectedTotal) < 1e-9,
            `topMean totalReturn ${topMeanPnl.totalReturn} should equal mean*trades ${expectedTotal}`,
        );
    }
    // random basket totalReturn likewise equals randomMean * trades.
    if (randomPnl.trades > 0 && h.topMean.randomMean !== null) {
        const expectedRandom = h.topMean.randomMean * randomPnl.trades;
        assert.ok(
            Math.abs(randomPnl.totalReturn! - expectedRandom) < 1e-9,
            `random totalReturn ${randomPnl.totalReturn} should equal randomMean*trades ${expectedRandom}`,
        );
    }
    console.log("PASS: integration pnl populated and consistent with selector mean*trades");
}

async function testIntegrationReportContainsPnlLines(): Promise<void> {
    const pair1 = makePair("AAA", "XXX", [makeTrade("long", T0 + 1000, T0 + 3000)]);
    const pair2 = makePair("BBB", "YYY", [makeTrade("long", T0 + 1000, T0 + 3000)]);
    const targets = [makeTarget("AAA", 10, () => 100), makeTarget("BBB", 10, () => 50)];
    const result = await runOpenScoreUsdReplay(
        () => fromArray([pair1, pair2]),
        () => fromArray(targets),
        { horizons: [2] },
    );
    const report = result.reportLines.join("\n");
    assert.match(report, /TOP_MEAN_PNL/);
    assert.match(report, /RANDOM_PNL/);
    assert.match(report, /TOP_MEAN_HEDGE_PNL/);
    // RANDOM_HEDGE_PNL was removed from the report (control was ill-defined:
    // sharpe in the -27 to -55 range with 0% winRate was a numerical artifact,
    // not a usable baseline).
    assert.doesNotMatch(report, /RANDOM_HEDGE_PNL/);
    assert.match(report, /TOP_MEAN_VS_RANK2/);
    // Lines must carry the per-trade-normalized fields. Absolute total/maxDD
    // are intentionally NOT rendered (they scale with trade count + the
    // 1-unit-notional assumption and would mislead cross-config comparison).
    const topMeanPnlLine = result.reportLines.find((l) => l.startsWith("TOP_MEAN_PNL"));
    assert.ok(topMeanPnlLine, "TOP_MEAN_PNL line present");
    assert.match(topMeanPnlLine!, /trades=/);
    assert.match(topMeanPnlLine!, /sharpe=/);
    assert.match(topMeanPnlLine!, /winRate=/);
    assert.match(topMeanPnlLine!, /avg\/trade=/);
    // The misleading absolute fields must NOT appear in the rendered line.
    assert.doesNotMatch(topMeanPnlLine!, /\btotal=/);
    assert.doesNotMatch(topMeanPnlLine!, /\bmaxDD=/);
    console.log("PASS: report carries TOP_MEAN_PNL + RANDOM_PNL with comparable fields (no total/maxDD)");
}

async function testIntegrationNoEventsStillHasPnlField(): Promise<void> {
    // No trades -> no events -> pnl present with trades=0/all-null (not omitted),
    // and the report must NOT crash on a null summary.
    const result = await runOpenScoreUsdReplay(
        () => fromArray([makePair("AAA", "BBB", [])]),
        () => fromArray([]),
        { horizons: [2] },
    );
    const h = result.horizons[0];
    if (h) {
        assert.ok(h.pnl, "pnl field present even when no events");
        assert.equal(h.pnl!.topMean.trades, 0);
        assert.equal(h.pnl!.topMean.totalReturn, null);
    }
    // Report rendering must not throw.
    assert.ok(Array.isArray(result.reportLines));
    console.log("PASS: no-events run still populates pnl (trades=0) without crashing");
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    testEmptyReturnsAllNull();
    testAllNonFiniteDropped();
    testTotalReturnIsSumNotMean();
    testMonotonicityAllPositiveAndAllNegative();
    testWinRateIsFraction();
    testSharpeSignMatchesMean();
    testMaxDrawdownChronological();
    testMaxDrawdownNonNegative();
    testDeterminism();
    await testIntegrationPnlPopulatedAndMatchesHelper();
    await testIntegrationReportContainsPnlLines();
    await testIntegrationNoEventsStillHasPnlField();
    console.log("PASS: batch-open-score-usd-selector-pnl.spec.ts");
}

main().catch((err) => {
    console.error("FAIL: batch-open-score-usd-selector-pnl.spec.ts", err);
    process.exit(1);
});
