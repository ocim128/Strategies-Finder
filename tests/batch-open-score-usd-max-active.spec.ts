import { expect } from "chai";
import { describe, it } from "node:test";
import {
    runOpenScoreUsdReplay,
    type OpenScoreUsdTarget,
} from "../lib/batch-backtest/batch-open-score-usd-replay-engine";
import type { BatchSyntheticPairArtifact } from "../lib/batch-backtest/batch-synthetic-state-miner";
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
