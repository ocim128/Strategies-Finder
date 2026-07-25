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

/** Pair artifact whose data/signals are unused by the replay engine (only trades matter). */
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

function makeDirectMarket(asset: string, trades: Trade[]): BatchSyntheticPairArtifact {
    return {
        symbol: `${asset}USDT`,
        baseAsset: asset,
        quoteAsset: "",
        data: [],
        signals: [],
        result: { ...emptyResult(), totalTrades: trades.length, trades },
    };
}

/** Target OHLCV: bars at T0, T0+1000, T0+2000, ... with constant price. */
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

describe("batch-open-score-usd-replay-engine", () => {
    it("returns a no-horizon message when horizons are empty", async () => {
        const result = await runOpenScoreUsdReplay(
            () => fromArray([]),
            () => fromArray([]),
            { horizons: [] },
        );
        expect(result.reportLines.join("\n")).to.match(/no valid horizons/i);
    });

    it("returns a no-deltas message when artifacts have no trades", async () => {
        const result = await runOpenScoreUsdReplay(
            () => fromArray([makePair("AAA", "BBB", [])]),
            () => fromArray([]),
            { horizons: [3] },
        );
        expect(result.pairs).to.equal(1);
        expect(result.reportLines.join("\n")).to.match(/no trade deltas/i);
    });

    it("creates a decision event only on entry timestamps, never on exits alone", async () => {
        // Pair enters long at bar 1, exits at bar 3. Exit-only timestamp (bar 3)
        // must NOT create an event. Only the entry timestamp (bar 1) is an event.
        const pair = makePair("AAA", "BBB", [makeTrade("long", T0 + 1000, T0 + 3000)]);
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 50),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray([pair]),
            () => fromArray(targets),
            { horizons: [2] },
        );
        // Long AAA/BBB -> AAA +1, BBB -1 at entry. Only ONE positive candidate
        // (AAA), so the event is ineligible for top-vs-random (< 2 positives).
        expect(result.totalEvents).to.equal(1);
        expect(result.eligibleEvents).to.equal(0);
    });

    it("replays direct crypto markets as one-asset signals", async () => {
        const markets = [
            makeDirectMarket("AAA", [makeTrade("long", T0 + 1000, null)]),
            makeDirectMarket("BBB", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, (i) => 100 + i),
            makeTarget("BBB", 10, (i) => 100 - i),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(markets),
            () => fromArray(targets),
            { horizons: [2] },
        );
        expect(result.pairs).to.equal(2);
        expect(result.assets).to.equal(2);
        expect(result.totalEvents).to.equal(1);
        expect(result.eligibleEvents).to.equal(1);
    });

    it("long entry maps base +1 / quote -1; short entry maps base -1 / quote +1", async () => {
        // Two pairs sharing asset AAA as base: one long (AAA+1) one short (AAA-1).
        // Net AAA raw = 0 -> AAA not positive. Quote of long pair (BBB) = -1,
        // quote of short pair (CCC) = +1. Only CCC positive -> 1 candidate.
        const pairs = [
            makePair("AAA", "BBB", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "CCC", [makeTrade("short", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 50),
            makeTarget("CCC", 10, () => 25),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2] },
        );
        expect(result.totalEvents).to.equal(1);
        // Only CCC has rawScore > 0 -> ineligible (needs >= 2 positives).
        expect(result.eligibleEvents).to.equal(0);
        expect(result.degree.max).to.equal(2); // AAA has static degree 2
    });

    it("applies all same-timestamp entries+exits before forming candidates (no leak)", async () => {
        // At T1: pair1 long AAA/BBB exits (AAA -1, BBB +1) AND pair2 long CCC/DDD enters.
        // Post-execution score must reflect the exit. We assert the event exists
        // (an entry occurred at T1) and that USD lookup starts on the FOLLOWING bar.
        const pairs = [
            makePair("AAA", "BBB", [makeTrade("long", T0, T0 + 1000)]),   // exit at T1
            makePair("CCC", "DDD", [makeTrade("long", T0 + 1000, null)]), // entry at T1
        ];
        // Targets: constant price so return is 0; we only care about event timing.
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 50),
            makeTarget("CCC", 10, () => 25),
            makeTarget("DDD", 10, () => 10),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2] },
        );
        // Two entry timestamps: T0 (pair1 entry) and T1 (pair2 entry). T1 also has
        // pair1's exit, but only one event per timestamp.
        expect(result.totalEvents).to.equal(2);
    });

    it("picks the top raw-score asset and beats the exact random control by the known amount", async () => {
        // Event at T1: three pairs enter long. raw: AAA=2, BBB=1, CCC=-1, DDD=-1.
        // Positives: AAA(2), BBB(1). topRaw=AAA, random control = BBB only.
        // Eligibility requires EVERY positive candidate to have target data, so
        // both AAA and BBB datasets are provided.
        const pairs = [
            makePair("AAA", "CCC", [makeTrade("long", T0 + 1000, null)]), // AAA+1 CCC-1
            makePair("AAA", "DDD", [makeTrade("long", T0 + 1000, null)]), // AAA+1 DDD-1
            makePair("BBB", "EEE", [makeTrade("long", T0 + 1000, null)]), // BBB+1 EEE-1
        ];
        // Linear ramps: AAA +10%/bar, BBB +2%/bar. Decision at bar 1, so the USD
        // entry is bar 2's open (first bar strictly after T1). horizon 3 -> exit
        // at close of bar 2+3-1 = bar 4.
        const targets = [
            makeTarget("AAA", 10, (i) => 100 * (1 + 0.10 * i)),
            makeTarget("BBB", 10, (i) => 50 * (1 + 0.02 * i)),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [3], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        expect(result.eligibleEvents).to.equal(1);
        const h = result.horizons[0]!;
        expect(h.bars).to.equal(3);
        // AAA open(2)=120, close(4)=140 -> 140/120-1 = 1/6
        // BBB open(2)=52,  close(4)=54  -> 54/52-1
        const expectedTop = 140 / 120 - 1;
        const expectedRand = 54 / 52 - 1;
        expect(h.topRaw.topMean).to.be.closeTo(expectedTop, 1e-9);
        expect(h.topRaw.randomMean).to.be.closeTo(expectedRand, 1e-9);
        expect(h.topRaw.delta).to.be.closeTo(expectedTop - expectedRand, 1e-9);
    });

    it("same-score ties break deterministically by the frozen FNV-1a digest every run", async () => {
        // Two assets with identical raw score (both +1). Per the Phase 0 freeze,
        // tie-break = the smallest FNV-1a 64 digest of
        // `max_active_tie_v1|1|truncatedEventTimeSec|scoringAsset` — NOT asset
        // name, NOT input order. Both runs must produce byte-identical reports.
        const pairs = [
            makePair("ZZZ", "QQQ", [makeTrade("long", T0 + 1000, null)]), // ZZZ+1
            makePair("AAA", "QQQ", [makeTrade("long", T0 + 1000, null)]), // AAA+1 (QQQ now -2)
        ];
        // raw: ZZZ=1, AAA=1, QQQ=-2. Positives: ZZZ, AAA. Tie.
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("ZZZ", 10, () => 50),
        ];
        const run = () => runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], blockCount: 1 },
        );
        const r1 = await run();
        const r2 = await run();
        expect(r1.eligibleEvents).to.equal(1);
        // Determinism: both runs produce the same selection and report.
        expect(r1.horizons[0]!.topRaw.delta).to.equal(r2.horizons[0]!.topRaw.delta);
        expect(r1.reportLines.join("\n")).to.equal(r2.reportLines.join("\n"));
        // The tie counter must fire for the RAW selector.
        expect(r1.horizons[0]!.tieRates.RAW.sameSelection).to.equal(1);
        expect(r1.horizons[0]!.tieRates.RAW.events).to.equal(1);
    });

    it("applies slippage and commission identically to both arms", async () => {
        const pairs = [
            makePair("AAA", "CCC", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "DDD", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, (i) => 100 + i),
            makeTarget("BBB", 10, (i) => 50 + i * 0.5),
        ];
        const base = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const costed = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0.001, commissionRate: 0.0005, blockCount: 1 },
        );
        expect(base.eligibleEvents).to.equal(1);
        expect(costed.eligibleEvents).to.equal(1);
        // Costs reduce the top return but leave the delta structure intact.
        const topBase = base.horizons[0]!.topRaw.topMean!;
        const topCosted = costed.horizons[0]!.topRaw.topMean!;
        expect(topCosted).to.be.lessThan(topBase);
        // Commission round-trip = 2 * 0.0005 = 0.001 drag, plus slippage on both sides.
        expect(topBase - topCosted).to.be.greaterThan(0.001);
    });

    it("omits right-censored events instead of zero-filling them", async () => {
        // Event at T1 with horizon 5, but target only has 3 bars -> censored.
        const pairs = [
            makePair("AAA", "CCC", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "DDD", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 3, () => 100), // too short for horizon 5
            makeTarget("BBB", 3, () => 50),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [5], blockCount: 1 },
        );
        // No eligible events (all censored) and a warning is emitted — never a fake 0 return.
        expect(result.eligibleEvents).to.equal(0);
        expect(result.warnings.join(" ")).to.match(/right-censored/i);
    });

    it("surfaces missing target datasets as incomplete, never as zero returns", async () => {
        const pairs = [
            makePair("AAA", "CCC", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "DDD", [makeTrade("long", T0 + 1000, null)]),
        ];
        // Only AAA's dataset is provided; BBB (a positive candidate) is missing.
        const targets = [makeTarget("AAA", 10, () => 100)];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], blockCount: 1 },
        );
        expect(result.complete).to.equal(false);
        expect(result.omittedAssets).to.equal(1);
        expect(result.eligibleEvents).to.equal(0);
        expect(result.warnings.join(" ")).to.match(/no usable target dataset/i);
    });

    it("reports unequal static pair degree without altering raw-score math", async () => {
        // AAA appears in 3 pairs (degree 3), BBB in 1 (degree 1). Raw score is a
        // plain vote count — degree is reported but does not normalize raw.
        const pairs = [
            makePair("AAA", "XXX", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "YYY", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "ZZZ", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "WWW", [makeTrade("long", T0 + 1000, null)]),
        ];
        // raw: AAA=3, BBB=1. Positives AAA,BBB -> top=AAA (higher raw).
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 50),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], blockCount: 1 },
        );
        expect(result.degree.max).to.equal(3);
        expect(result.degree.min).to.equal(1);
        expect(result.eligibleEvents).to.equal(1);
        // Adjusted = raw/sqrt(activePairCount): AAA 3/sqrt(3)=1.732, BBB 1/sqrt(1)=1.
        // So TOP_RAW picks AAA (3>1); both arms still produce a finite delta.
        expect(result.horizons[0]!.topRaw.topMean).to.not.equal(null);
    });

    it("reports coverage controls that separate score edge from pair-degree concentration", async () => {
        // At T1 the positive candidates intentionally produce different
        // winners for every diagnostic rule:
        //   TOP_RAW / MAX_ACTIVE -> AAA (raw=3, active=5)
        //   TOP_ADJUSTED         -> BBB (2/sqrt(2) > 3/sqrt(5))
        //   TOP_MEAN             -> tie (BBB, AAB, ZZZ, DDD all raw/active=1)
        //                          broken by the FNV-1a digest of
        //                          `max_active_tie_v1|1|t|asset`. At t=1700001000
        //                          ZZZ has the smallest digest, so TOP_MEAN -> ZZZ.
        //   MAX_STATIC           -> DDD (six submitted pairs, one active)
        // This proves the report is evaluating genuinely different selectors,
        // rather than printing aliases of TOP_RAW.
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "X2", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "X3", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "X4", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAA", "ZZZ", [makeTrade("short", T0 + 1000, null)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Y2", [makeTrade("long", T0 + 1000, null)]),
            makePair("AAB", "Y3", [makeTrade("long", T0 + 1000, null)]),
            makePair("DDD", "Y4", [makeTrade("long", T0 + 1000, null)]),
            ...Array.from({ length: 5 }, (_, i) => makePair("DDD", `EMPTY${i}`, [])),
        ];
        const targetWithReturn = (asset: string, forwardReturn: number): OpenScoreUsdTarget =>
            makeTarget(asset, 10, (i) => i === 3 ? 100 * (1 + forwardReturn) : 100);
        const targets = [
            targetWithReturn("AAA", 0.10),
            targetWithReturn("BBB", 0.20),
            targetWithReturn("AAB", 0.30),
            targetWithReturn("DDD", 0.40),
            targetWithReturn("ZZZ", 0.05),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const horizon = result.horizons[0]!;
        expect(horizon.topRaw.topMean).to.be.closeTo(0.10, 1e-9);
        expect(horizon.topAdjusted.topMean).to.be.closeTo(0.20, 1e-9);
        // TOP_MEAN tie (BBB=AAB=ZZZ=DDD=1.0) -> FNV-1a digest picks ZZZ.
        expect(horizon.topMean.topMean).to.be.closeTo(0.05, 1e-9);
        expect(horizon.topMeanVsRaw.topMean).to.be.closeTo(0.05, 1e-9);
        expect(horizon.topMeanVsRaw.randomMean).to.be.closeTo(0.10, 1e-9);
        expect(horizon.topMeanVsRaw.delta).to.be.closeTo(-0.05, 1e-9);
        expect(horizon.topMeanVsRaw.blockMeans[0]).to.be.closeTo(-0.05, 1e-9);
        expect(horizon.topMeanVsRaw.positiveBlocks).to.equal(0);
        expect(horizon.topMeanVsRaw.totalBlocks).to.equal(1);
        expect(horizon.maxActive.topMean).to.be.closeTo(0.10, 1e-9);
        expect(horizon.maxStatic.topMean).to.be.closeTo(0.40, 1e-9);
        expect(horizon.rawAdjustedAgreement).to.deep.equal({ events: 1, sameSelection: 0, rate: 0 });
        expect(horizon.dominantAsset).to.equal("AAA");
        expect(horizon.topRawExDominant.events).to.equal(0);
        const aaaSummary = horizon.topRawByAsset.find((x) => x.asset === "AAA")!;
        expect(aaaSummary.events).to.equal(1);
        expect(aaaSummary.share).to.equal(1);
        expect(aaaSummary.topMean).to.be.closeTo(0.10, 1e-9);
        expect(aaaSummary.randomMean).to.be.closeTo(0.2375, 1e-9);
        expect(aaaSummary.delta).to.be.closeTo(-0.1375, 1e-9);
        expect(result.reportLines.join("\n")).to.include("controls | TOP_MEAN=raw/activePairs");
        expect(result.reportLines.join("\n")).to.include("TOP_MEAN_VS_RAW");
        expect(result.reportLines.join("\n")).to.include("TOP_MEAN_VS_RAW_WF deltaByBlock=[-5.00%]");
    });

    it("controls legend documents the MAX_ACTIVE_REVERSION short-side arm", async () => {
        // Any runnable scenario produces the legend line; the body of the
        // run is irrelevant. We just need to lock the legend wording so a
        // future refactor cannot silently drop the reversion entry.
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 3, () => 100),
            makeTarget("BBB", 3, () => 100),
            makeTarget("X1", 3, () => 100),
            makeTarget("Y1", 3, () => 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        expect(result.reportLines.join("\n")).to.include(
            "MAX_ACTIVE_REVERSION=most open pairs among negative-score assets, shorted vs USD",
        );
    });

    it("labels zero-event horizons as unusable even when all datasets loaded", async () => {
        const pairs = [
            makePair("AAA", "CCC", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "DDD", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 3, () => 100),
            makeTarget("BBB", 3, () => 50),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [5], blockCount: 1 },
        );
        expect(result.complete).to.equal(true);
        expect(result.candidateEvents).to.equal(1);
        expect(result.reportLines.join("\n")).to.include("coverage=0/1 (0.0%) NO_USABLE_EVENTS");
        expect(result.reportLines[0]).to.include("DATA_COMPLETE");
    });

    it("reports TOP_RAW performance after removing the dominant selected asset", async () => {
        const pairs = [
            makePair("AAA", "X1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("AAA", "X2", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("BBB", "Y1", [makeTrade("long", T0 + 1000, T0 + 2000)]),
            makePair("CCC", "Z1", [makeTrade("long", T0 + 3000, null)]),
            makePair("CCC", "Z2", [makeTrade("long", T0 + 3000, null)]),
            makePair("DDD", "W1", [makeTrade("long", T0 + 3000, null)]),
        ];
        const targets = [
            makeTarget("AAA", 10, (i) => i === 3 ? 110 : 100),
            makeTarget("BBB", 10, () => 100),
            makeTarget("CCC", 10, (i) => i === 5 ? 120 : 100),
            makeTarget("DDD", 10, () => 100),
        ];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], slippageRate: 0, commissionRate: 0, blockCount: 1 },
        );
        const horizon = result.horizons[0]!;
        // AAA and CCC each win once; the deterministic count/name ordering
        // names AAA dominant. Removing AAA's event must leave CCC's +20%
        // return against DDD's flat random control.
        expect(horizon.dominantAsset).to.equal("AAA");
        expect(horizon.topRawExDominant.events).to.equal(1);
        expect(horizon.topRawExDominant.topMean).to.be.closeTo(0.20, 1e-9);
        expect(horizon.topRawExDominant.delta).to.be.closeTo(0.20, 1e-9);
    });

    it("cancels during the artifact scan when shouldStop returns true", async () => {
        const pairs = [makePair("AAA", "BBB", [makeTrade("long", T0 + 1000, null)])];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray([]),
            { horizons: [2], shouldStop: () => true },
        );
        expect(result.reportLines.join("\n")).to.match(/cancelled/i);
    });

    it("decrements activePairCount on exit deltas so TOP_ADJUSTED is not corrupted by round-trips", async () => {
        // Audit F1 regression: activePairCount must track CURRENTLY-OPEN pairs
        // (entries +1, exits -1). The previous implementation added abs(delta)
        // on every delta, so the adjusted denominator grew on each exit too
        // and TOP_ADJUSTED silently picked the wrong asset.
        //
        // Setup: at T1 two pairs enter long. Pair1 closes normally at T2.
        //   Pair1 long AAA/CCC: AAA +1, CCC -1 at T1; AAA -1, CCC +1 at T2.
        //   Pair2 long BBB/DDD: BBB +1, DDD -1 at T1; never closes.
        // At T1 (the decision event): rawScore AAA=1, BBB=1, CCC=-1, DDD=-1.
        //   Positives: AAA(1), BBB(1). activePairCount: AAA=1, BBB=1.
        //   adjustedScore: AAA=1/sqrt(1)=1, BBB=1/sqrt(1)=1 -> tie, name asc -> AAA.
        // If the bug were still present, AAA's count would still be 1 at T1
        // (the exit hadn't happened yet), so the bug needs a LATER event to
        // manifest. To catch the post-exit inflation we add a second decision
        // event at T3 where pair2 is still open and pair1 has cycled:
        //   Pair3 long AAA/EEE enters at T3 (AAA +1, EEE -1), never closes.
        // At T3: rawScore AAA=1 (pair1 round-trip nets 0 + pair3 +1), BBB=1, EEE=-1.
        //   activePairCount CORRECT: AAA=1 (pair1 gone, pair3 open), BBB=1.
        //   adjustedScore CORRECT: AAA=1/sqrt(1)=1, BBB=1/sqrt(1)=1.
        //   activePairCount BUGGY (abs(delta)): AAA=3 (pair1 +1 entry +1 exit + pair3 +1), BBB=1.
        //     -> adjustedScore AAA = 1/sqrt(3) = 0.577 < BBB's 1.0
        //     -> TOP_ADJUSTED picks BBB (wrong) instead of AAA (tie).
        const pairs = [
            makePair("AAA", "CCC", [makeTrade("long", T0 + 1000, T0 + 2000)]), // T1 entry, T2 exit
            makePair("BBB", "DDD", [makeTrade("long", T0 + 1000, null)]),      // T1 entry, open
            makePair("AAA", "EEE", [makeTrade("long", T0 + 3000, null)]),      // T3 entry, open
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
        // Both decision events (T1 and T3) qualify. At T3 the corrected
        // activePairCount makes AAA tie BBB at adjustedScore=1; tie breaks by
        // name -> AAA. With the bug, BBB strictly wins T3's TOP_ADJUSTED and
        // the report's TOP_ADJUSTED events would be skewed. Assert the
        // candidateDegree's max active pair count is 1 (not 3) for AAA.
        const horizon = result.horizons[0]!;
        // maxActivePairs across events = 1 (only one pair open per asset at
        // any decision event). The bug would have surfaced max=3.
        expect(horizon.candidateDegree.max).to.equal(1);
        // The corrected engine should produce equal TOP_RAW and TOP_ADJUSTED
        // means at T3 (AAA ties BBB on adjusted after the fix). Eligible
        // events are 2 (T1 and T3); both have >= 2 positive candidates with
        // valid target data for AAA and BBB.
        expect(result.eligibleEvents).to.equal(2);
        expect(horizon.topAdjusted.events).to.equal(2);
    });

    it("reports active coverage from positive candidates, not a negative-score asset", async () => {
        const pairs = [
            makePair("AAA", "A1", [makeTrade("long", T0 + 1000, null)]),
            makePair("BBB", "B1", [makeTrade("long", T0 + 1000, null)]),
            makePair("NEG", "N1", [makeTrade("short", T0 + 1000, null)]),
            makePair("NEG", "N2", [makeTrade("short", T0 + 1000, null)]),
            makePair("NEG", "N3", [makeTrade("short", T0 + 1000, null)]),
        ];
        const targets = ["AAA", "BBB", "N1", "N2", "N3"].map((asset) => makeTarget(asset, 10, () => 100));
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], blockCount: 1 },
        );
        // NEG has three active pair votes but a negative score. Every positive
        // candidate has one active pair, so the reported candidate coverage is 1.
        expect(result.horizons[0]!.candidateDegree.max).to.equal(1);
    });

    it("merges per-pair delta streams in global timestamp order (k-way merge parity)", async () => {
        // Audit F2 parity: artifacts arrive in arbitrary order; the merged
        // delta sequence must be the same as a global sort regardless of the
        // order the artifactLoader yields them. Same setup as the
        // "same-timestamp exits+entries" test, but with the pairs yielded in
        // reverse so the per-pair streams arrive out of chronological order.
        const pairsInOrder = [
            makePair("AAA", "BBB", [makeTrade("long", T0, T0 + 1000)]),   // exit at T1
            makePair("CCC", "DDD", [makeTrade("long", T0 + 1000, null)]), // entry at T1
        ];
        const reversed = [...pairsInOrder].reverse();
        const targets = [
            makeTarget("AAA", 10, () => 100),
            makeTarget("BBB", 10, () => 50),
            makeTarget("CCC", 10, () => 25),
            makeTarget("DDD", 10, () => 10),
        ];
        const inOrder = await runOpenScoreUsdReplay(
            () => fromArray(pairsInOrder),
            () => fromArray(targets),
            { horizons: [2] },
        );
        const outOfOrder = await runOpenScoreUsdReplay(
            () => fromArray(reversed),
            () => fromArray(targets),
            { horizons: [2] },
        );
        // Both arrival orders must produce identical reports (deterministic
        // k-way merge with stream-index tie-break).
        expect(outOfOrder.totalEvents).to.equal(inOrder.totalEvents);
        expect(outOfOrder.eligibleEvents).to.equal(inOrder.eligibleEvents);
        expect(outOfOrder.reportLines.join("\n")).to.equal(inOrder.reportLines.join("\n"));
    });

    it("counts an artifact with no trades as omitted and still reports static pair degree", async () => {
        // Audit F3 + F5: a pair with zero usable trades (e.g. disk read
        // failure yielding a tombstone, or a pair that simply produced no
        // signals) must be counted as omittedPair, but its legs must still
        // contribute to static pair degree so the coverage-bias answer
        // describes the submitted pair list, not just the pairs that traded.
        const pairs = [
            makePair("BBB", "DDD", []),                                  // 0 trades; unique legs
            makePair("AAA", "CCC", [makeTrade("long", T0 + 1000, null)]),
        ];
        const targets = [makeTarget("AAA", 10, () => 100)];
        const result = await runOpenScoreUsdReplay(
            () => fromArray(pairs),
            () => fromArray(targets),
            { horizons: [2], blockCount: 1 },
        );
        // One pair omitted (the empty-trades one).
        expect(result.omittedPairs).to.equal(1);
        expect(result.pairs).to.equal(2);
        // The omitted pair's unique legs must still be part of the submitted
        // asset universe and static degree. If asset registration happened
        // after the no-trade check, these two assets would disappear.
        expect(result.assets).to.equal(4);
        expect(result.degree.min).to.equal(1);
        expect(result.degree.max).to.equal(1);
    });
});
