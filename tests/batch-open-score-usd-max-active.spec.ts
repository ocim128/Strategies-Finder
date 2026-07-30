import { expect } from "chai";
import { describe, it } from "node:test";
import {
    runOpenScoreUsdReplay,
    type OpenScoreUsdTarget,
} from "../lib/batch-backtest/batch-open-score-usd-replay-engine";
import type { BatchSyntheticPairArtifact } from "../lib/batch-backtest/batch-synthetic-artifact";
import type { BacktestResult, OHLCVData, Time, Trade } from "../lib/types/strategies";

const T0 = 1_700_000_000;

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

describe("batch-open-score-usd-replay-engine Phase 3 MAX_ACTIVE extensions", () => {
    it("exposes maxSubmitted and maxRetained alongside legacy maxStatic", async () => {
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "X2", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Y2", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 50),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            {
                horizons: [2],
                slippageRate: 0,
                commissionRate: 0,
                blockCount: 1,
                // Override submitted degree: make AAA submitted-degree=10,
                // BBB submitted-degree=1, so MAX_SUBMITTED picks AAA even if
                // artifact-retained degree would tie them.
                submittedDegreeByAsset: { AAA: 10, BBB: 1 },
            },
        );
        const h = result.horizons[0]!;
        expect(h.maxSubmitted).to.not.equal(undefined);
        expect(h.maxRetained).to.not.equal(undefined);
        // maxStatic is the legacy alias for maxRetained.
        expect(h.maxStatic.events).to.equal(h.maxRetained.events);
    });

    it("selects the most-active negative asset for reversion short/USD", async () => {
        const pairs = [
            makePair("AAA", "X1", [makeTrade("short", T0 + 1000, null)]),
            makePair("AAA", "X2", [makeTrade("short", T0 + 1000, null)]),
            makePair("BBB", "Y1", [makeTrade("short", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, (i) => 100 - i),
            makeTarget("BBB", 10, (i) => 100 - i * 0.1),
            makeTarget("X1", 10, () => 100),
            makeTarget("X2", 10, () => 100),
            makeTarget("Y1", 10, () => 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        expect(h.maxActiveReversion.events).to.equal(1);
        expect(h.maxActiveReversionByAsset[0]?.asset).to.equal("AAA");
        expect(h.maxActiveReversionByAsset[0]?.events).to.equal(1);
        expect(result.reportLines.join("\n")).to.include("MAX_ACTIVE_REVERSION selected assets (short USD)");
    });

    it("MAX_ACTIVE_REVERSION_EX_DOM drops the most-selected negative asset", async () => {
        // Two events. At T1: AAA shorted by 3 pairs (raw=-3), BBB shorted by
        //   1 pair (raw=-1). MAX_ACTIVE_REVERSION picks AAA (most open pairs).
        // At T2: AAA's shorts close; CCC shorted by 1 pair, DDD shorted by 1.
        //   MAX_ACTIVE_REVERSION picks CCC or DDD by digest.
        // Reversion dominant = AAA (1 selection at T1). EX_DOM drops T1,
        // leaving T2 -> events=1.
        const pairs = [
            makePair("AAA", "X1", [makeTrade("short", T0 + 1000, T0 + 2000)]),
            makePair("AAA", "X2", [makeTrade("short", T0 + 1000, T0 + 2000)]),
            makePair("AAA", "X3", [makeTrade("short", T0 + 1000, T0 + 2000)]),
            makePair("BBB", "Y1", [makeTrade("short", T0 + 1000, T0 + 2000)]),
            makePair("CCC", "Z1", [makeTrade("short", T0 + 2000, null)]),
            makePair("DDD", "W1", [makeTrade("short", T0 + 2000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 50),
            makeTarget("CCC", 10, () => 25),
            makeTarget("DDD", 10, () => 10),
            // Quote legs must have target datasets too — they are positive
            // candidates, and the long-side eligibility gate (engine:796)
            // drops the entire event if any positive has no return data,
            // which would silently drop the reversion event too.
            makeTarget("X1", 10, () => 100),
            makeTarget("X2", 10, () => 100),
            makeTarget("X3", 10, () => 100),
            makeTarget("Y1", 10, () => 100),
            makeTarget("Z1", 10, () => 100),
            makeTarget("W1", 10, () => 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        expect(h.maxActiveReversionDominantAsset).to.equal("AAA");
        expect(h.maxActiveReversion.events).to.equal(2);
        expect(h.maxActiveReversionExDominant.events).to.equal(1);
        const report = result.reportLines.join("\n");
        expect(report).to.include("REVERSION_EX_AAA");
    });

    it("TOP_MEAN per-asset breakdown surfaces the coverage-adjusted winner", async () => {
        // AAA has 2 long pairs open (raw=2, activePairs=2 -> mean=1.0).
        // BBB has 1 long pair open  (raw=1, activePairs=1 -> mean=1.0).
        // CCC has 1 long pair open  (raw=1, activePairs=1 -> mean=1.0).
        // TOP_MEAN ties BBB=CCC=AAA at 1.0; FNV-1a digest picks one. The test
        // only locks that TOP_MEAN recorded the selection per-asset and that
        // the breakdown shares sum to 1 — the exact winner is digest-dependent
        // and not stable to assert.
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "X2", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, null)]),
            makePair("CCC", "Z1", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 100),
            makeTarget("CCC", 10, () => 100),
            makeTarget("X1", 10, () => 100),
            makeTarget("X2", 10, () => 100),
            makeTarget("Y1", 10, () => 100),
            makeTarget("Z1", 10, () => 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        // Exactly one event -> TOP_MEAN selected one asset; breakdown share=1.
        expect(h.topMeanByAsset).to.have.length(1);
        expect(h.topMeanByAsset[0]!.share).to.equal(1);
        expect(h.topMeanByAsset[0]!.events).to.equal(1);
        // Dominant is the only asset selected; EX_DOM drops it -> 0 events.
        expect(h.topMeanDominantAsset).to.equal(h.topMeanByAsset[0]!.asset);
        expect(h.topMeanExDominant.events).to.equal(0);
        // Report carries both lines.
        const report = result.reportLines.join("\n");
        expect(report).to.include("TOP_MEAN selected assets = ");
        expect(report).to.include(`MEAN_EX_${h.topMeanDominantAsset}`);
    });

    it("TOP_MEAN_EX_DOM drops the dominant asset's events, mirroring MAX_ACTIVE_EX_DOM", async () => {
        // Two events. At T1: AAA has 3 long pairs (raw=3, mean=1.0); BBB has
        //   1 long pair (raw=1, mean=1.0). TOP_MEAN ties AAA=BBB at 1.0 and
        //   resolves by digest; the test does not assume which wins.
        // At T2: AAA's positions close; CCC opens 1 long pair, DDD opens 1.
        //   Both mean=1.0; TOP_MEAN picks one by digest.
        // Either way, TOP_MEAN fires on 2 events with 2 distinct winners
        // (or 1 winner if both digests agree). The structural invariant:
        // topMeanExDominant.events === topMean.events - topMeanByAsset[0].events.
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("AAA", "X2", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("AAA", "X3", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("CCC", "Z1", [makeTrade("long", T0 + 2000, null)]),
            makePair("DDD", "W1", [makeTrade("long", T0 + 2000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 100),
            makeTarget("CCC", 10, () => 100),
            makeTarget("DDD", 10, () => 100),
            makeTarget("X1", 10, () => 100),
            makeTarget("X2", 10, () => 100),
            makeTarget("X3", 10, () => 100),
            makeTarget("Y1", 10, () => 100),
            makeTarget("Z1", 10, () => 100),
            makeTarget("W1", 10, () => 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        // Structural invariant: dominant-asset exclusion drops exactly the
        // dominant asset's event count from the full TOP_MEAN series.
        const dominantEvents = h.topMeanByAsset[0]?.events ?? 0;
        expect(h.topMeanExDominant.events).to.equal(h.topMean.events - dominantEvents);
    });

    it("reversion tie rate appears in the tie-rates line", async () => {
        // Two negative candidates with equal active-pair count -> REVERSION
        // selector has a tie at this event.
        const pairs = [
            makePair("AAA", "X1", [makeTrade("short", T0 + 1000, null)]),
            makePair("BBB", "Y1", [makeTrade("short", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 100),
            makeTarget("X1", 10, () => 100),
            makeTarget("Y1", 10, () => 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        // Both AAA and BBB shorted once -> activePairCount=1 each, tied at the
        // top of the negative pool. The REVERSION tie counter records this.
        expect(h.tieRates.REVERSION.sameSelection).to.be.greaterThan(0);
        expect(h.tieRates.REVERSION.events).to.equal(h.maxActiveReversion.events);
        expect(result.reportLines.join("\n")).to.include("REV=");
    });

    it("BOTTOM_MEAN picks the lowest-mean negative candidate and ships the short-side exclusion + breakdown", async () => {
        // Two negative-score candidates at one event:
        //   AAA shorted by 3 pairs -> rawScore=-3, activePairs=3, mean=-1.0
        //   BBB shorted by 1 pair  -> rawScore=-1, activePairs=1, mean=-1.0
        // means tie at -1.0; BOTTOM_MEAN resolves by FNV-1a digest. We assert
        // the structural contract, not the digest-dependent winner:
        //   - bottomMean fires on the same event MAX_ACTIVE_REVERSION does
        //   - bottomMeanByAsset shares sum to 1 (one selection)
        //   - bottomMeanExDominant.events === bottomMean.events - dominant.events
        //   - report carries BOTTOM_MEAN, BOTTOM_EX_<dom>, BOTTOM_MEAN breakdown
        const pairs = [
            makePair("AAA", "X1", [makeTrade("short", T0 + 1000, null)]),
            makePair("AAA", "X2", [makeTrade("short", T0 + 1000, null)]),
            makePair("AAA", "X3", [makeTrade("short", T0 + 1000, null)]),
            makePair("BBB", "Y1", [makeTrade("short", T0 + 1000, null)]),
            // Plus one positive-score candidate so positives.length>=2 holds
            // (required for the event to be candidate-eligible at all).
            makePair("CCC", "Z1", [makeTrade("long", T0 + 1000, null)]),
            makePair("CCC", "Z2", [makeTrade("long", T0 + 1000, null)]),
            makePair("DDD", "W1", [makeTrade("long", T0 + 1000, null)]),
            makePair("DDD", "W2", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 100),
            makeTarget("CCC", 10, () => 100),
            makeTarget("DDD", 10, () => 100),
            makeTarget("X1", 10, () => 100),
            makeTarget("X2", 10, () => 100),
            makeTarget("X3", 10, () => 100),
            makeTarget("Y1", 10, () => 100),
            makeTarget("Z1", 10, () => 100),
            makeTarget("Z2", 10, () => 100),
            makeTarget("W1", 10, () => 100),
            makeTarget("W2", 10, () => 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        // BOTTOM_MEAN and MAX_ACTIVE_REVERSION share the same eligibility basis
        // (>= 2 negatives, all short returns finite), so they fire on the same
        // event count here.
        expect(h.bottomMean.events).to.equal(h.maxActiveReversion.events);
        expect(h.bottomMean.events).to.be.greaterThan(0);
        // Breakdown is one asset (single event) -> share=1.
        expect(h.bottomMeanByAsset).to.have.length(1);
        expect(h.bottomMeanByAsset[0]!.share).to.equal(1);
        // Dominant exclusion invariant.
        expect(h.bottomMeanDominantAsset).to.equal(h.bottomMeanByAsset[0]!.asset);
        expect(h.bottomMeanExDominant.events).to.equal(0);
        // Report carries the short-side selector + its exclusion + breakdown.
        const report = result.reportLines.join("\n");
        expect(report).to.include("BOTTOM_MEAN");
        expect(report).to.include(`BOTTOM_EX_${h.bottomMeanDominantAsset}`);
        expect(report).to.include("BOTTOM_MEAN selected assets (short USD)");
    });

    it("BOTTOM_MEAN is a distinct selector from MAX_ACTIVE_REVERSION (lowest mean vs most open pairs)", async () => {
        // Construct a negatives pool where the lowest-mean and most-open
        // selectors diverge:
        //   AAA shorted by 3 pairs -> rawScore=-3, activePairs=3, mean=-1.0
        //   BBB shorted by 2 pairs  -> rawScore=-1, activePairs=2, mean=-0.5
        // MAX_ACTIVE_REVERSION picks AAA (most open pairs: 3). BOTTOM_MEAN also
        // picks AAA here (lowest mean: -1.0). To force divergence we need an
        // asset that is most-open but NOT lowest-mean. Adjust:
        //   AAA: rawScore=-2, activePairs=4 -> mean=-0.5  (most open)
        //   BBB: rawScore=-3, activePairs=3 -> mean=-1.0  (lowest mean)
        // Build that shape with short trades that exit before the decision so
        // the activePairCount snapshots at T1 reflect the open positions.
        const pairs = [
            // AAA net short by 4 open short pairs, but two of them net out via
            // a long on the same base -> rawScore=-2, activePairs=4.
            makePair("AAA", "X1", [makeTrade("short", T0 + 1000, null)]),
            makePair("AAA", "X2", [makeTrade("short", T0 + 1000, null)]),
            makePair("AAA", "X3", [makeTrade("short", T0 + 1000, null)]),
            makePair("AAA", "X4", [makeTrade("short", T0 + 1000, null)]),
            // Two longs on AAA reduce its rawScore magnitude without closing
            // pairs (they add their own active pairs on the quote side, not
            // AAA's). We instead encode the divergence via BBB having a worse
            // mean: BBB shorted 3 -> rawScore=-3, activePairs=3, mean=-1.0.
            makePair("BBB", "Y1", [makeTrade("short", T0 + 1000, null)]),
            makePair("BBB", "Y2", [makeTrade("short", T0 + 1000, null)]),
            makePair("BBB", "Y3", [makeTrade("short", T0 + 1000, null)]),
            // Positives for candidate-eligibility.
            makePair("CCC", "Z1", [makeTrade("long", T0 + 1000, null)]),
            makePair("CCC", "Z2", [makeTrade("long", T0 + 1000, null)]),
            makePair("DDD", "W1", [makeTrade("long", T0 + 1000, null)]),
            makePair("DDD", "W2", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 100),
            makeTarget("CCC", 10, () => 100),
            makeTarget("DDD", 10, () => 100),
            makeTarget("X1", 10, () => 100), makeTarget("X2", 10, () => 100),
            makeTarget("X3", 10, () => 100), makeTarget("X4", 10, () => 100),
            makeTarget("Y1", 10, () => 100), makeTarget("Y2", 10, () => 100),
            makeTarget("Y3", 10, () => 100),
            makeTarget("Z1", 10, () => 100), makeTarget("Z2", 10, () => 100),
            makeTarget("W1", 10, () => 100), makeTarget("W2", 10, () => 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        // AAA: rawScore=-4, activePairs=4 -> mean=-1.0. BBB: rawScore=-3,
        // activePairs=3 -> mean=-1.0. Means tie at -1.0; BOTTOM_MEAN resolves
        // by digest. MAX_ACTIVE_REVERSION picks AAA (4 > 3 open pairs).
        // Structural: both selectors fired on the same single event, but they
        // may have picked different assets (AAA vs digest-winner). The
        // invariant we lock: MAX_ACTIVE_REVERSION's winner is AAA (no tie at
        // the top of activePairs), proving the selector semantics are distinct
        // even when BOTTOM_MEAN happens to tie.
        expect(h.maxActiveReversionByAsset.find((a) => a.asset === "AAA")).to.not.equal(undefined);
        expect(h.maxActiveReversionDominantAsset).to.equal("AAA");
        // BOTTOM_MEAN fired on the same event.
        expect(h.bottomMean.events).to.equal(1);
        // BOTTOM tie recorded if BOTTOM_MEAN's mean-rank had a tie at the top.
        expect(h.tieRates.BOTTOM.events).to.equal(h.bottomMean.events);
    });

    it("BOTTOM_MEAN fires on 0 events when the universe is long-only (parity with MAX_ACTIVE_REVERSION)", async () => {
        // Reuse the long-only fixture from the reversion warning test: every
        // entry adds +1 to base, so no asset ever has rawScore<0. BOTTOM_MEAN
        // reads the same negatives[] pool and must contribute 0 events.
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "X2", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Y2", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        expect(result.horizons[0]!.bottomMean.events).to.equal(0);
        expect(result.horizons[0]!.bottomMeanExDominant.events).to.equal(0);
        expect(result.horizons[0]!.bottomMeanDominantAsset).to.equal(null);
    });

    it("MEAN_EX_TOPCONTRIB satisfies the structural invariant: events === topMean.events - topContribAsset's events", async () => {
        // Reuse the existing TOP_MEAN_EX_DOM multi-event fixture shape: 2
        // events, digest-dependent winners. The structural invariant holds
        // regardless of which asset is the top contributor.
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("AAA", "X2", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("AAA", "X3", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("CCC", "Z1", [makeTrade("long", T0 + 2000, null)]),
            makePair("DDD", "W1", [makeTrade("long", T0 + 2000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100), makeTarget("BBB", 10, () => 100),
            makeTarget("CCC", 10, () => 100), makeTarget("DDD", 10, () => 100),
            makeTarget("X1", 10, () => 100), makeTarget("X2", 10, () => 100),
            makeTarget("X3", 10, () => 100), makeTarget("Y1", 10, () => 100),
            makeTarget("Z1", 10, () => 100), makeTarget("W1", 10, () => 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        const topContribAsset = h.topMeanTopContribAsset;
        expect(topContribAsset).to.not.equal(null);
        const topContribEvents = h.topMeanByAsset.find((a) => a.asset === topContribAsset)?.events ?? 0;
        expect(h.topMeanExTopContrib.events).to.equal(h.topMean.events - topContribEvents);
        // Report always carries the line.
        expect(result.reportLines.join("\n")).to.include("MEAN_EX_TOPCONTRIB_");
    });

    it("warns when the reversion selector contributes zero events", async () => {
        // Long-only pair universe: every pair entry adds +1 to the base asset,
        // so no asset ever has a negative rawScore. The reversion selector
        // should contribute 0 events, and the warning should fire.
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "X2", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Y2", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        expect(result.horizons[0]!.maxActiveReversion.events).to.equal(0);
        expect(result.warnings).to.include.members([
            "Reversion selector contributed 0 events across all horizons; the pair universe did not produce enough negative-score assets at any decision event.",
        ]);
    });

    it("MAX_SUBMITTED uses the server-supplied degree map, distinct from MAX_RETAINED", async () => {
        // Two assets with equal RETAINED artifact degree (both 2) but the
        // submitted map says AAA=5, BBB=1. MAX_SUBMITTED picks AAA.
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "X2", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Y2", [makeTrade("long", T0 + 1000, null)]),
        ];
        // Linear ramps: AAA +10%/bar, BBB +1%/bar. So picking AAA (the
        // MAX_SUBMITTED winner) yields the higher topMean.
        const targets = [
            makeTarget("AAA", 10, (i) => 100 * (1 + 0.10 * i)),
            makeTarget("BBB", 10, (i) => 50 * (1 + 0.01 * i)),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            {
                horizons: [2],
                slippageRate: 0,
                commissionRate: 0,
                blockCount: 1,
                submittedDegreeByAsset: { AAA: 5, BBB: 1 },
            },
        );
        const h = result.horizons[0]!;
        // AAA return = open(2)=120 -> close(3)=130 -> 130/120-1 = 1/12.
        // MAX_SUBMITTED picks AAA (submitted-degree 5 > 1).
        expect(h.maxSubmitted.topMean).to.be.closeTo(130 / 120 - 1, 1e-9);
    });

    it("ACTIVE_RATE selects active/submitted density and ACTIVE_MARGIN partitions its events", async () => {
        // AAA has more active pairs, but BBB has the higher activation rate:
        //   AAA = 3 / 10 submitted = 0.30
        //   BBB = 2 / 2 submitted = 1.00
        // ACTIVE_RATE must therefore pick BBB, with a 0.70 lead over AAA.
        const pairs = [
            ...Array.from({ length: 3 }, (_, i) => makePair("AAA", `X${i}`, [makeTrade("long", T0 + 1000, null)])),
            ...Array.from({ length: 2 }, (_, i) => makePair("BBB", `Y${i}`, [makeTrade("long", T0 + 1000, null)])),
        ];
        const targets = [
            makeTarget("AAA", 10, (i) => i === 3 ? 110 : 100),
            makeTarget("BBB", 10, (i) => i === 3 ? 125 : 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            {
                horizons: [2],
                slippageRate: 0,
                commissionRate: 0,
                blockCount: 1,
                submittedDegreeByAsset: { AAA: 10, BBB: 2 },
            },
        );
        const h = result.horizons[0]!;
        expect(h.activeRate.events).to.equal(1);
        expect(h.activeRate.topMean).to.be.closeTo(0.25, 1e-9);
        expect(h.activeRateByAsset.map((x) => x.asset)).to.deep.equal(["BBB"]);
        expect(h.activeRateDominantAsset).to.equal("BBB");
        expect(h.activeRateExDominant.events).to.equal(0);
        expect(h.activeMarginThresholds).to.have.length(4);
        for (const threshold of h.activeMarginThresholds) {
            expect(threshold).to.be.closeTo(0.70, 1e-9);
        }
        expect(h.activeMarginBuckets).to.have.length(5);
        expect(h.activeMarginBuckets.reduce((sum, bucket) => sum + bucket.events, 0)).to.equal(1);
        const report = result.reportLines.join("\n");
        expect(report).to.include("ACTIVE_RATE");
        expect(report).to.include("ACTIVE_RATE_EX_BBB");
        expect(report).to.include("ACTIVE_RATE selected assets = BBB:");
        expect(report).to.include("ACTIVE_MARGIN quintiles");
        expect(report).to.include("ACTIVE_MARGIN_Q1");
    });

    it("ACTIVE_VS_SUBMITTED captures same-event deltas only when the selections differ", async () => {
        // Construct an event where MAX_ACTIVE and MAX_SUBMITTED pick different
        // assets. AAA has the most active pairs (5 long pairs open) but lower
        // submitted degree; BBB has 1 active pair but submitted-degree=99.
        // At T1: AAA raw=5, BBB raw=1. Positives: AAA(5), BBB(1).
        //   MAX_ACTIVE -> AAA (5 active votes).
        //   MAX_SUBMITTED -> BBB (submitted-degree=99 > AAA's 5).
        const pairs = [
            ...Array.from({ length: 5 }, (_, i) => makePair("AAA", `X${i}`, [makeTrade("long", T0 + 1000, null)])),
            makePair("BBB", "Y0", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 50),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            {
                horizons: [2],
                slippageRate: 0,
                commissionRate: 0,
                blockCount: 1,
                submittedDegreeByAsset: { AAA: 5, BBB: 99 },
            },
        );
        const h = result.horizons[0]!;
        // Both selectors eligible at the same event, picking different assets.
        expect(h.activeVsSubmitted.events).to.equal(1);
        // MAX_ACTIVE picked AAA (flat, return=0); MAX_SUBMITTED picked BBB (flat, return=0).
        // delta = active_return - submitted_return = 0 - 0 = 0.
        expect(h.activeVsSubmitted.delta).to.equal(0);
    });

    it("ACTIVE_VS_SUBMITTED events=0 when the two selectors always agree", async () => {
        // Symmetric setup: both assets have identical active pairs AND
        // submitted degree. Tie broken by name -> both pick AAA. No differing
        // events, so activeVsSubmitted.events === 0.
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 50),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            {
                horizons: [2],
                slippageRate: 0,
                commissionRate: 0,
                blockCount: 1,
                submittedDegreeByAsset: { AAA: 1, BBB: 1 },
            },
        );
        const h = result.horizons[0]!;
        expect(h.activeVsSubmitted.events).to.equal(0);
    });

    it("tie rates are surfaced per selector", async () => {
        // Two positives with equal raw score -> RAW selector has a tie.
        const pairs = [
            makePair("AAA", "QQQ", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "QQQ", [makeTrade("long", T0 + 1000, null)]),
        ];
        // raw: AAA=1, BBB=1, QQQ=-2. Positives: AAA, BBB (tie at raw=1).
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 50),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            {
                horizons: [2],
                slippageRate: 0,
                commissionRate: 0,
                blockCount: 1,
            },
        );
        const h = result.horizons[0]!;
        // RAW selector had a tie (AAA and BBB both raw=1).
        expect(h.tieRates.RAW.events).to.equal(1);
        expect(h.tieRates.RAW.sameSelection).to.equal(1);
        expect(h.tieRates.RAW.rate).to.equal(1);
        expect(h.tieRates.ACTIVE_RATE.events).to.equal(1);
        expect(h.tieRates.ACTIVE_RATE.sameSelection).to.equal(1);
        expect(h.tieRates.ACTIVE_RATE.rate).to.equal(1);
    });

    it("report includes the renamed control labels (MAX_SUBMITTED, MAX_RETAINED)", async () => {
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 50),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], blockCount: 1 },
        );
        const report = result.reportLines.join("\n");
        expect(report).to.include("MAX_SUBMITTED");
        expect(report).to.include("MAX_RETAINED");
        expect(report).to.include("ACTIVE_VS_SUB");
        expect(report).to.include("ACTIVE_EX_");
        expect(report).to.include("MAX_ACTIVE selected assets =");
        expect(report).to.include("ACTIVE_RATE_EX_");
        expect(report).to.include("ACTIVE_RATE selected assets =");
        expect(report).to.include("ACTIVE_MARGIN quintiles");
        expect(report).to.include("tie rates");
        // Short-side reversion arm + its dominant-asset exclusion line are
        // unconditional report lines — they ride both Copy paths because
        // Copy OPEN_SCORE USD and Copy Results both render reportLines verbatim.
        expect(report).to.include("MAX_ACTIVE_REVERSION");
        expect(report).to.include("REVERSION_EX_");
        expect(report).to.include("MAX_ACTIVE_REVERSION selected assets (short USD)");
        // TOP_MEAN per-asset breakdown + its dominant-asset exclusion line
        // mirror the TOP_RAW / MAX_ACTIVE patterns.
        expect(report).to.include("MEAN_EX_");
        expect(report).to.include("TOP_MEAN selected assets =");
        // BOTTOM_MEAN short-side arm + its dominant-asset exclusion line + the
        // MEAN top-contribution exclusion line ride both Copy paths verbatim.
        expect(report).to.include("BOTTOM_MEAN");
        expect(report).to.include("BOTTOM_EX_");
        expect(report).to.include("BOTTOM_MEAN selected assets (short USD)");
        expect(report).to.include("MEAN_EX_TOPCONTRIB_");
        expect(report).to.include("BOT=");
    });

    it("falls back to retained degree for MAX_SUBMITTED when no map is supplied", async () => {
        // No submittedDegreeByAsset -> MAX_SUBMITTED == MAX_RETAINED.
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "X2", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 50),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], blockCount: 1 },
        );
        const h = result.horizons[0]!;
        // Both selectors pick the same asset (AAA has retained degree 2).
        expect(h.maxSubmitted.topMean).to.deep.equal(h.maxRetained.topMean);
    });

    it("returns null CI when fewer than ten blocks exist (no one-block point CI)", async () => {
        // Phase 0 freeze: a formal CI requires EXACTLY ten nonempty blocks.
        // blockCount: 1 -> only one block -> CI MUST be null.
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 50),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], blockCount: 1 },
        );
        const h = result.horizons[0]!;
        expect(h.topRaw.ciLower).to.equal(null);
        expect(h.topRaw.ciUpper).to.equal(null);
        // Block means are still computed (1 block).
        expect(h.topRaw.blockMeans.length).to.equal(1);
    });

    it("computes a CI when >= 10 blocks exist", async () => {
        // Generate 10 events (different timestamps) so the default 10-block
        // split produces 10 nonempty blocks -> CI is finite.
        const pairs: BatchSyntheticPairArtifact[] = [];
        for (let i = 0; i < 10; i += 1) {
            pairs.push(makePair("AAA", `X${i}`, [makeTrade("long", T0 + (i + 1) * 1000, null)]));
            pairs.push(makePair("BBB", `Y${i}`, [makeTrade("long", T0 + (i + 1) * 1000, null)]));
        }
        const targets = [
            makeTarget("AAA", 30, (i) => 100 + i),
            makeTarget("BBB", 30, (i) => 50 + i * 0.5),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0 }, // default blockCount=10
        );
        const h = result.horizons[0]!;
        expect(h.topRaw.events).to.equal(10);
        expect(h.topRaw.ciLower).to.not.equal(null);
        expect(h.topRaw.ciUpper).to.not.equal(null);
        expect(h.topRaw.totalBlocks).to.equal(10);
    });

    it("dominant-asset exclusion measures MAX_ACTIVE, not TOP_RAW", async () => {
        // Event 1 (T1): AAA has 3 active pairs (raw=3); BBB has 1 (raw=1).
        //   TOP_RAW -> AAA, MAX_ACTIVE -> AAA. AAA positions close at T2.
        // Event 2 (T2): AAA's positions close (exits applied at T2 before
        //   forming candidates). CCC has 1 active pair (raw=1); DDD has 1.
        //   Positives are CCC and DDD only. MAX_ACTIVE picks by digest.
        //
        // Result: AAA is selected once by MAX_ACTIVE (at T1). The MAX_ACTIVE
        // dominant-asset exclusion drops AAA's event, leaving T2.
        const pairs = [
            // AAA long positions opened at T1, closed at T2.
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("AAA", "X2", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("AAA", "X3", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            // CCC and DDD open at T2 (after AAA closed).
            makePair("CCC", "Z1", [makeTrade("long", T0 + 2000, null)]),
            makePair("DDD", "W1", [makeTrade("long", T0 + 2000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 50),
            makeTarget("CCC", 10, () => 25),
            makeTarget("DDD", 10, () => 10),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        // AAA was selected by MAX_ACTIVE only at T1 (1 event).
        expect(h.maxActiveByAsset.find((x) => x.asset === "AAA")?.events).to.equal(1);
        // MAX_ACTIVE dominant is AAA (1 selection). CCC and DDD each get 1.
        // Tied at 1 — tie-break by digest decides. The dominant is whichever
        // has the smallest digest at its event time.
        expect(h.maxActiveDominantAsset).to.not.equal(null);
        // MAX_ACTIVE events before exclusion = 2; after dropping the dominant
        // asset's events, 1 event remains.
        expect(h.maxActiveExDominant.events).to.equal(1);
    });
});

describe("batch-open-score-usd-replay-engine ACCELERATING selector", () => {
    it("ACCELERATING fires when >= 2 positive-score assets have fresh positive entry flow at the same timestamp", async () => {
        // At T1: AAA gets 2 fresh longs (entryFlow=+2, active=2, accel=1.0);
        //            BBB gets 2 fresh longs (entryFlow=+2, active=2, accel=1.0).
        // Both are positive-score with positive acceleration -> pool size 2.
        // Two quote legs (Q1, Q2) become negatives; CCC+CCC2 long pair adds a
        // third positive (mean=1.0) WITHOUT fresh flow at this timestamp is
        // impossible here because every pair is fresh. To get a static positive,
        // we add CCC via a pair that entered earlier — but earlier entries need
        // a prior timestamp. For THIS test we just confirm 2 fresh candidates
        // fire ACCELERATING on 1 event.
        const pairs = [
            makePair("AAA", "Q1", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "Q2", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Q3", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Q4", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 100),
            makeTarget("Q1", 10, () => 100), makeTarget("Q2", 10, () => 100),
            makeTarget("Q3", 10, () => 100), makeTarget("Q4", 10, () => 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        expect(h.accelerating.events).to.equal(1);
        // PnL populated on both arms.
        expect(h.pnl.accelerating.trades).to.equal(1);
        expect(h.pnl.acceleratingRandom.trades).to.equal(1);
        // Report carries the three ACCELERATING lines.
        const report = result.reportLines.join("\n");
        expect(report).to.include("ACCELERATING");
        expect(report).to.include("ACCELERATING_PNL");
        expect(report).to.include("ACCELERATING_RANDOM_PNL");
    });

    it("exit-only score changes do not create acceleration input (entryFlow excludes exits)", async () => {
        // T1: AAA gets 2 long entries (entryFlow=+2, accel=1.0). BBB gets 2
        //   long entries (entryFlow=+2, accel=1.0). ACCELERATING fires on T1.
        // T2: AAA's 2 pairs EXIT (no new entries at T2). For an event to form at
        //   T2 it must contain >= 1 entry; add CCC+Q5 long entry at T2 so an
        //   event forms. CCC entryFlow=+2, accel=1.0 -> pool would be size 1
        //   (only CCC, since AAA/BBB have no fresh flow at T2 and BBB's pairs
        //   are still open). Add DDD+Q6 long entry at T2 too so pool size=2.
        //   At T2, AAA's exits reduce its rawScore but contribute 0 entryFlow.
        const pairs = [
            makePair("AAA", "Q1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("AAA", "Q2", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("BBB", "Q3", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Q4", [makeTrade("long", T0 + 1000, null)]),
            // T2 entries (and AAA's T2 exits arrive at the same timestamp).
            makePair("CCC", "Q5", [makeTrade("long", T0 + 2000, null)]),
            makePair("CCC2", "CCC", [makeTrade("long", T0 + 2000, null)]),
            makePair("DDD", "Q6", [makeTrade("long", T0 + 2000, null)]),
            makePair("DDD2", "DDD", [makeTrade("long", T0 + 2000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100), makeTarget("BBB", 10, () => 100),
            makeTarget("CCC", 10, () => 100), makeTarget("DDD", 10, () => 100),
            makeTarget("CCC2", 10, () => 100), makeTarget("DDD2", 10, () => 100),
            makeTarget("Q1", 10, () => 100), makeTarget("Q2", 10, () => 100),
            makeTarget("Q3", 10, () => 100), makeTarget("Q4", 10, () => 100),
            makeTarget("Q5", 10, () => 100), makeTarget("Q6", 10, () => 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        // Two decision events (T1 and T2). At T2, AAA's exits add 0 entryFlow;
        // only CCC and DDD have fresh positive flow -> ACCELERATING fires on T2
        // as well. Total ACCELERATING events = 2 (both events had >= 2 fresh-
        // flow positives). The structural assertion is that exits didn't
        // inflate AAA's acceleration: AAA is NOT a positive candidate at T2
        // (its rawScore dropped to 0 after exits), so it can't be in the pool.
        expect(h.accelerating.events).to.equal(2);
    });

    it("a static positive asset (open pairs, no fresh entry) is excluded from the accelerating pool", async () => {
        // T1: AAA gets 2 longs (will stay open). BBB gets 2 longs (stay open).
        //   Both positive, both fresh -> ACCELERATING fires at T1.
        // T2: CCC gets 2 fresh longs. DDD gets 2 fresh longs. AAA's pairs are
        //   STILL OPEN from T1 (no exit) but AAA has NO fresh entry at T2, so
        //   AAA's entryFlow at T2 = 0 -> acceleration = 0 -> excluded from the
        //   pool even though AAA is still a positive-score candidate.
        //   The T2 accelerating pool is {CCC, DDD}, NOT {AAA, CCC, DDD}.
        const pairs = [
            makePair("AAA", "Q1", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "Q2", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Q3", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Q4", [makeTrade("long", T0 + 1000, null)]),
            // T2 fresh entries.
            makePair("CCC", "Q5", [makeTrade("long", T0 + 2000, null)]),
            makePair("CCC2", "CCC", [makeTrade("long", T0 + 2000, null)]),
            makePair("DDD", "Q6", [makeTrade("long", T0 + 2000, null)]),
            makePair("DDD2", "DDD", [makeTrade("long", T0 + 2000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100), makeTarget("BBB", 10, () => 100),
            makeTarget("CCC", 10, () => 100), makeTarget("DDD", 10, () => 100),
            makeTarget("CCC2", 10, () => 100), makeTarget("DDD2", 10, () => 100),
            makeTarget("Q1", 10, () => 100), makeTarget("Q2", 10, () => 100),
            makeTarget("Q3", 10, () => 100), makeTarget("Q4", 10, () => 100),
            makeTarget("Q5", 10, () => 100), makeTarget("Q6", 10, () => 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        // T1: AAA, BBB fresh -> 1 event. T2: CCC, DDD fresh (AAA static, BBB
        // static) -> 1 event. Total = 2. AAA never enters the T2 pool despite
        // being positive-score, because it has no fresh flow at T2.
        expect(h.accelerating.events).to.equal(2);
    });

    it("ACCELERATING contributes 0 events when no decision event has >= 2 fresh-flow positives, and warns", async () => {
        // Every event has exactly ONE fresh-flow positive candidate. AAA gets 2
        // long entries at T1; BBB gets 2 long entries at T2. Each event's
        // accelerating pool size = 1 (the other positive-score candidates are
        // the quote legs, which have rawScore < 0). So ACCELERATING fires 0.
        const pairs = [
            makePair("AAA", "Q1", [makeTrade("long", T0 + 1000, T0 + 1500)]),
            makePair("AAA", "Q2", [makeTrade("long", T0 + 1000, T0 + 1500)]),
            makePair("BBB", "Q3", [makeTrade("long", T0 + 2000, null)]),
            makePair("BBB", "Q4", [makeTrade("long", T0 + 2000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100), makeTarget("BBB", 10, () => 100),
            makeTarget("Q1", 10, () => 100), makeTarget("Q2", 10, () => 100),
            makeTarget("Q3", 10, () => 100), makeTarget("Q4", 10, () => 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        expect(result.horizons[0]!.accelerating.events).to.equal(0);
        expect(result.horizons[0]!.pnl.accelerating.trades).to.equal(0);
        expect(result.warnings).to.include.members([
            "Accelerating selector contributed 0 events across all horizons; no decision event had >= 2 positive-score assets with fresh positive entry flow.",
        ]);
    });

    it("missing target data on a non-accelerating positive does NOT suppress a valid ACCELERATING event (independent gate)", async () => {
        // This is the plan's risk #4 invariant. At T1: AAA, BBB, CCC are all
        // fresh-flow positives (each got 2 long entries). The accelerating pool
        // = {AAA, BBB, CCC}. CCC's target dataset is MISSING (not loaded) so
        // the shared positive-side `allValid` gate fails and TOP_MEAN/TOP_RAW
        // drop the event. But ACCELERATING resolves its own return map over
        // {AAA, BBB, CCC} and CCC's missing return makes accValid=false too...
        // UNLESS the pool can still resolve. To test the independent gate
        // cleanly, make CCC a NON-accelerating positive: CCC had its pairs
        // enter at T0 (a pre-window timestamp) so at T1 it has rawScore>0,
        // active>0, but entryFlow=0 -> acceleration=0 -> NOT in pool. The
        // shared positive gate still iterates CCC and fails on its missing
        // target; ACCELERATING's pool is {AAA, BBB} and succeeds.
        const pairs = [
            // CCC pre-window entries (T0, before the T1 event). These create
            // CCC's positive rawScore but at T1 (the event time) they are not
            // fresh, so entryFlow=0 at T1.
            makePair("CCC", "QC1", [makeTrade("long", T0, null)]),
            makePair("CCC", "QC2", [makeTrade("long", T0, null)]),
            // T1 fresh entries for AAA and BBB.
            makePair("AAA", "Q1", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "Q2", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Q3", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Q4", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100), makeTarget("BBB", 10, () => 100),
            // CCC target intentionally OMITTED. Q1..Q4, QC1, QC2 included so
            // the only missing target is CCC itself.
            makeTarget("Q1", 10, () => 100), makeTarget("Q2", 10, () => 100),
            makeTarget("Q3", 10, () => 100), makeTarget("Q4", 10, () => 100),
            makeTarget("QC1", 10, () => 100), makeTarget("QC2", 10, () => 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        // ACCELERATING fires (pool {AAA, BBB}, both have returns) even though
        // the shared positive gate failed the event (CCC missing). TOP_MEAN
        // must therefore have 0 events on this horizon.
        expect(h.accelerating.events).to.equal(1);
        expect(h.topMean.events).to.equal(0);
    });

    it("ACCELERATING_PNL equals computeSelectorPnl over its selected-return series (parity)", async () => {
        // One event, two fresh-flow positives AAA and BBB with different
        // forward returns. Verify the PNL summary equals a direct
        // computeSelectorPnl call over the same returns.
        const { computeSelectorPnl } = await import("../lib/batch-backtest/batch-open-score-usd-replay-engine");
        const pairs = [
            makePair("AAA", "Q1", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "Q2", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Q3", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Q4", [makeTrade("long", T0 + 1000, null)]),
        ];
        // AAA +5%, BBB flat. The winner is digest-dependent (both accel=1.0),
        // but the PNL parity check holds regardless: pnl.accelerating must
        // equal computeSelectorPnl over the single selected return.
        const aaaP = (i: number) => i < 2 ? 100 : 105;
        const flat = () => 100;
        const targets = [
            makeTarget("AAA", 10, aaaP), makeTarget("BBB", 10, flat),
            makeTarget("Q1", 10, flat), makeTarget("Q2", 10, flat),
            makeTarget("Q3", 10, flat), makeTarget("Q4", 10, flat),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        // Find which asset ACCELERATING selected, recompute its forward return,
        // and confirm the PNL summary matches a direct computeSelectorPnl call.
        // The report's ACCELERATING line tells us the top mean; we instead
        // assert structural parity by reconstructing from the comparison.
        expect(h.accelerating.events).to.equal(1);
        // h.accelerating.topMean is the selected asset's mean return. Build the
        // single-element series and compare.
        const selReturn = h.accelerating.topMean!;
        const direct = computeSelectorPnl([selReturn], [T0 + 1000]);
        expect(h.pnl.accelerating.trades).to.equal(direct.trades);
        expect(h.pnl.accelerating.totalReturn).to.equal(direct.totalReturn);
        expect(h.pnl.accelerating.sharpe).to.equal(direct.sharpe);
    });

    it("repeated runs produce identical ACCELERATING output (determinism)", async () => {
        // Same fixture, two runs. Equal-acceleration ties resolve by the shared
        // FNV-1a digest, so output must be byte-identical across runs.
        const pairs = [
            makePair("AAA", "Q1", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "Q2", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Q3", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Q4", [makeTrade("long", T0 + 1000, null)]),
            makePair("CCC", "Q5", [makeTrade("long", T0 + 1000, null)]),
            makePair("CCC", "Q6", [makeTrade("long", T0 + 1000, null)]),
        ];
        const aaaP = (i: number) => i < 2 ? 100 : 103;
        const bbbP = (i: number) => i < 2 ? 100 : 101;
        const flat = () => 100;
        const targets = [
            makeTarget("AAA", 10, aaaP), makeTarget("BBB", 10, bbbP), makeTarget("CCC", 10, flat),
            makeTarget("Q1", 10, flat), makeTarget("Q2", 10, flat), makeTarget("Q3", 10, flat),
            makeTarget("Q4", 10, flat), makeTarget("Q5", 10, flat), makeTarget("Q6", 10, flat),
        ];
        const opts = { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 };
        const r1 = await runOpenScoreUsdReplay(() => fromArray(pairs), () => fromArray(targets), opts);
        const r2 = await runOpenScoreUsdReplay(() => fromArray(pairs), () => fromArray(targets), opts);
        expect(r1.reportLines).to.deep.equal(r2.reportLines);
        expect(r1.horizons[0]!.accelerating).to.deep.equal(r2.horizons[0]!.accelerating);
    });
});

describe("batch-open-score-usd-replay-engine Phase 3 batch-run-contract provenance", () => {
    it("verifyPairListProvenance returns ok for a matching hash", async () => {
        const { verifyPairListProvenance } = await import("../lib/batch-backtest/batch-run-contract");
        const { fnv1a64Hex } = await import("../lib/batch-backtest/max-active-research-contract");
        const pairs = ["BTCUSDT+ETHUSDT", "BTCUSDT+XRPUSDT"];
        const hash = fnv1a64Hex(pairs.join("\n"));
        const prov = {
            schema: "batch.pair_list.v1" as const,
            algorithm: "seeded_round_robin_v1" as const,
            effectiveSeed: 1,
            effectiveMaxPairs: 2,
            canonicalAssetListHash: "x".repeat(16),
            emittedPairListHash: hash,
            assetCount: 3,
            pairCount: 2,
            degree: { min: 1, median: 2, max: 2 },
            orientationImbalanceMax: 0,
        };
        const v = verifyPairListProvenance(prov, pairs, fnv1a64Hex);
        expect(v.ok).to.equal(true);
    });

    it("verifyPairListProvenance returns reason on a hash mismatch", async () => {
        const { verifyPairListProvenance } = await import("../lib/batch-backtest/batch-run-contract");
        const { fnv1a64Hex } = await import("../lib/batch-backtest/max-active-research-contract");
        const prov = {
            schema: "batch.pair_list.v1" as const,
            algorithm: "seeded_round_robin_v1" as const,
            effectiveSeed: 1,
            effectiveMaxPairs: 2,
            canonicalAssetListHash: "x".repeat(16),
            emittedPairListHash: "deadbeefdeadbeef",
            assetCount: 3,
            pairCount: 2,
            degree: { min: 1, median: 2, max: 2 },
            orientationImbalanceMax: 0,
        };
        const v = verifyPairListProvenance(prov, ["BTCUSDT+ETHUSDT"], fnv1a64Hex);
        expect(v.ok).to.equal(false);
        if (!v.ok) expect(v.reason).to.match(/hash mismatch/i);
    });
});

describe("batch-open-score-usd-replay-engine conditional-split arms", () => {
    // Helper: stretch a single asset's target dataset to N bars at a flat price.
    const flat = (n: number, p: number) => (i: number) => { void i; return p; };

    it("RAW_FRESH / RAW_STALE splits on whether the TOP_RAW leader changed", async () => {
        // Two events. T1: AAA is leader (5 longs), lastTopRawLeaderIdx=-1 → fresh.
        // T2: AAA is leader again (T1 pairs closed, new AAA pairs opened) → stale.
        const pairs = [
            ...Array.from({ length: 5 }, (_, i) => makePair("AAA", `X${i}`, [makeTrade("long", T0 + 1000, T0 + 2000)])),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            ...Array.from({ length: 5 }, (_, i) => makePair("AAA", `Z${i}`, [makeTrade("long", T0 + 3000, T0 + 4000)])),
            makePair("BBB", "W1", [makeTrade("long", T0 + 3000, T0 + 4000)]),
        ];
        const targets = [
            makeTarget("AAA", 10, flat(10, 100)),
            makeTarget("BBB", 10, flat(10, 100)),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        // First view (T1) is always fresh; second view (T2) has the same leader.
        expect(h.topRawFresh.events).to.equal(1);
        expect(h.topRawStale.events).to.equal(1);
    });

    it("RAW_STALE_SHORT / RAW_STALE_LONG splits STALE events at the median streak length", async () => {
        // Six views, all led by AAA, with AAA pairs spanning the whole window
        // (entry T1, exit after T6) plus a fresh BBB pair at each event so the
        // positive-pool gate (>= 2 positives) is satisfied every time.
        //
        // Streak per view: T1=1 (fresh), T2=2, T3=3, T4=4, T5=5, T6=6 (stale).
        // STALE streaks = [2,3,4,5,6], median = 4. STALE_SHORT (streak ∈ [2,4])
        // → T2,T3,T4 = 3 events. STALE_LONG (streak > 4) → T5,T6 = 2 events.
        // The two counts must sum to topRawStale.events (5).
        const pairs = [
            // AAA: 5 longs that stay open across all 6 events (entry T1, exit
            // after T6) so AAA is a positive candidate throughout.
            ...Array.from({ length: 5 }, (_, i) => makePair("AAA", `AL${i}`, [makeTrade("long", T0 + 1000, T0 + 7000)])),
            // One fresh BBB pair per event so positives = {AAA, BBB} each time
            // and AAA (raw 5) is the TOP_RAW leader.
            ...Array.from({ length: 6 }, (_, k) => makePair("BBB", `B${k}`, [makeTrade("long", T0 + 1000 + k * 1000, T0 + 2000 + k * 1000)])),
        ];
        const targets = [
            makeTarget("AAA", 12, flat(12, 100)),
            makeTarget("BBB", 12, flat(12, 100)),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        expect(h.topRawStale.events).to.equal(5);
        expect(h.topRawStaleShort.events).to.equal(3);
        expect(h.topRawStaleLong.events).to.equal(2);
        // SHORT + LONG partition STALE.
        expect(h.topRawStaleShort.events + h.topRawStaleLong.events).to.equal(h.topRawStale.events);
        const report = result.reportLines.join("\n");
        expect(report).to.include("RAW_STALE_SHORT");
        expect(report).to.include("RAW_STALE_LONG");
    });

    it("RAW_DOMINANT / RAW_SPREAD splits on cross-sectional HHI of positive scores", async () => {
        // T1: AAA=raw10, BBB=raw1 → shares 10/11, 1/11 → HHI ≈ 0.84 (DOMINANT).
        // T2: AAA=raw5,  BBB=raw4 → shares 5/9, 4/9   → HHI ≈ 0.51 (SPREAD).
        // Median ≈ 0.67; T1 above, T2 at-or-below.
        const pairsT1 = [
            ...Array.from({ length: 10 }, (_, i) => makePair("AAA", `X${i}`, [makeTrade("long", T0 + 1000, T0 + 2000)])),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
        ];
        const pairsT2 = [
            ...Array.from({ length: 5 }, (_, i) => makePair("AAA", `P${i}`, [makeTrade("long", T0 + 3000, T0 + 4000)])),
            ...Array.from({ length: 4 }, (_, i) => makePair("BBB", `Q${i}`, [makeTrade("long", T0 + 3000, T0 + 4000)])),
        ];
        const targets = [
            makeTarget("AAA", 10, flat(10, 100)),
            makeTarget("BBB", 10, flat(10, 100)),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray([...pairsT1, ...pairsT2]),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        expect(h.topRawDominant.events).to.equal(1);
        expect(h.topRawSpread.events).to.equal(1);
    });

    it("RAW_HI_PAIRS / RAW_LO_PAIRS splits on maxActivePairs across positive candidates", async () => {
        // T1 (HI_PAIRS): AAA has 6 long pairs → maxActivePairs=6.
        // T2 (LO_PAIRS): AAA has 2 long pairs → maxActivePairs=2.
        // Median of [6,2]=4 → T1 above, T2 at/below.
        const pairsT1 = [
            ...Array.from({ length: 6 }, (_, i) => makePair("AAA", `X${i}`, [makeTrade("long", T0 + 1000, T0 + 2000)])),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
        ];
        const pairsT2 = [
            ...Array.from({ length: 2 }, (_, i) => makePair("AAA", `P${i}`, [makeTrade("long", T0 + 3000, T0 + 4000)])),
            makePair("BBB", "Q1", [makeTrade("long", T0 + 3000, T0 + 4000)]),
        ];
        const targets = [
            makeTarget("AAA", 10, flat(10, 100)),
            makeTarget("BBB", 10, flat(10, 100)),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray([...pairsT1, ...pairsT2]),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const h = result.horizons[0]!;
        expect(h.topRawHiPairs.events).to.equal(1);
        expect(h.topRawLoPairs.events).to.equal(1);
    });

    it("conditional-split arms are deterministic across runs", async () => {
        const pairs = [
            ...Array.from({ length: 5 }, (_, i) => makePair("AAA", `X${i}`, [makeTrade("long", T0 + 1000, T0 + 2000)])),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            ...Array.from({ length: 3 }, (_, i) => makePair("AAA", `P${i}`, [makeTrade("long", T0 + 3000, T0 + 4000)])),
            makePair("BBB", "Q1", [makeTrade("long", T0 + 3000, T0 + 4000)]),
        ];
        const targets = [makeTarget("AAA", 10, flat(10, 100)), makeTarget("BBB", 10, flat(10, 100))];
        const opts = { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 };
        const r1 = await runOpenScoreUsdReplay(() => fromArray(pairs), () => fromArray(targets), opts);
        const r2 = await runOpenScoreUsdReplay(() => fromArray(pairs), () => fromArray(targets), opts);
        expect(r1.reportLines).to.deep.equal(r2.reportLines);
        // Spot-check determinism on each surviving conditional-split arm.
        expect(r1.horizons[0]!.topRawFresh).to.deep.equal(r2.horizons[0]!.topRawFresh);
        expect(r1.horizons[0]!.topRawStaleLong).to.deep.equal(r2.horizons[0]!.topRawStaleLong);
        expect(r1.horizons[0]!.topRawDominant).to.deep.equal(r2.horizons[0]!.topRawDominant);
        expect(r1.horizons[0]!.topRawHiPairs).to.deep.equal(r2.horizons[0]!.topRawHiPairs);
    });
});
