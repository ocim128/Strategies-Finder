import { expect } from "chai";
import { describe, it } from "node:test";
import {
    runExposureRedundancyReport,
    MIN_RATIO_BAR_OVERLAP,
    MIN_TRADE_OVERLAP,
} from "../lib/spread-quality/spread-quality-engine";
import type { BatchSyntheticPairArtifact } from "../lib/batch-backtest/batch-synthetic-artifact";
import type { BacktestResult, OHLCVData, Time, Trade } from "../lib/types/strategies";

const DAY = 86400;

function makeCandles(length: number, priceAt: (index: number) => number, startSec = 1_700_000_000): OHLCVData[] {
    return Array.from({ length }, (_, index) => {
        const close = priceAt(index);
        return {
            time: (startSec + index * DAY) as Time,
            open: close,
            high: close + 0.5,
            low: close - 0.5,
            close,
            volume: 1000,
        };
    });
}

function makeTrade(id: number, exitIndex: number, pnl: number, startSec = 1_700_000_000): Trade {
    return {
        id,
        type: "long",
        entryTime: (startSec + (exitIndex - 1) * DAY) as Time,
        entryPrice: 100,
        exitTime: (startSec + exitIndex * DAY) as Time,
        exitPrice: 100 + pnl,
        pnl,
        pnlPercent: pnl,
        size: 1,
    };
}

function emptyResult(trades: Trade[]): BacktestResult {
    return {
        trades, netProfit: 0, netProfitPercent: 0, winRate: 0, expectancy: 0,
        avgTrade: 0, profitFactor: 0, maxDrawdown: 0, maxDrawdownPercent: 0,
        totalTrades: trades.length, winningTrades: 0, losingTrades: 0, avgWin: 0, avgLoss: 0,
        sharpeRatio: 0, equityCurve: [],
    };
}

function makeArtifact(
    symbol: string,
    baseAsset: string,
    quoteAsset: string,
    data: OHLCVData[],
    trades: Trade[],
): BatchSyntheticPairArtifact {
    return { symbol, baseAsset, quoteAsset, data, signals: [], result: emptyResult(trades) };
}

/** Feed an array through the async-iterable loader contract (one at a time). */
async function* loader(artifacts: BatchSyntheticPairArtifact[]): AsyncIterable<BatchSyntheticPairArtifact> {
    for (const artifact of artifacts) {
        yield artifact;
    }
}

describe("spread-quality-engine Exposure & Redundancy", () => {
    it("groups two pairs sharing an asset into one cluster and reports the shared asset incidence", async () => {
        // AAA shared by both pairs -> connected. BBB/CCC and DDD/EEE are the
        // distinct legs. Intent: incidence counts the shared leg once per pair,
        // and the bipartite connected-component merges them into ONE cluster.
        const data = makeCandles(MIN_RATIO_BAR_OVERLAP + 5, (i) => 100 + i);
        const artifacts = [
            makeArtifact("AAA+BBB", "AAA", "BBB", data, []),
            makeArtifact("AAA+CCC", "AAA", "CCC", data, []),
        ];
        const result = await runExposureRedundancyReport(() => loader(artifacts));

        expect(result.assetIncidence.find((entry) => entry.asset === "AAA")?.totalPairs).to.equal(2);
        expect(result.assetIncidence.find((entry) => entry.asset === "AAA")?.pairs).to.deep.equal(["AAA+BBB", "AAA+CCC"]);
        expect(result.assetIncidence.find((entry) => entry.asset === "AAA")?.grossSlotShare).to.equal(0.5);
        expect(result.assetIncidence.find((entry) => entry.asset === "BBB")?.totalPairs).to.equal(1);
        expect(result.assetIncidence.find((entry) => entry.asset === "CCC")?.totalPairs).to.equal(1);

        // Both pairs share AAA -> a single cluster of size 2 spanning 3 assets.
        expect(result.clusters.length).to.equal(1);
        expect(result.clusters[0]!.size).to.equal(2);
        expect(result.clusters[0]!.assets).to.deep.equal(["AAA", "BBB", "CCC"]);
        expect(result.clusters[0]!.pairs.sort()).to.deep.equal(["AAA+BBB", "AAA+CCC"]);
    });

    it("keeps disconnected pairs in separate clusters", async () => {
        const data = makeCandles(5, (i) => 100 + i);
        const artifacts = [
            makeArtifact("AAA+BBB", "AAA", "BBB", data, []),
            makeArtifact("CCC+DDD", "CCC", "DDD", data, []),
        ];
        const result = await runExposureRedundancyReport(() => loader(artifacts));
        // No shared asset -> two singleton clusters.
        expect(result.clusters.length).to.equal(2);
    });

    it("reports exit-P&L correlation = 1.0 for two pairs with perfectly correlated trade pnl at shared exit times", async () => {
        // Identical exit timestamps, perfectly linear pnl (b = 2*a) -> Pearson
        // must be exactly 1.0. Intent: the sparse exit-P&L join finds the
        // sparse exit-time join finds the overlap.
        const n = MIN_TRADE_OVERLAP + 5;
        const data = makeCandles(n + 2, (i) => 100 + i);
        const tradesA = Array.from({ length: n }, (_, i) => makeTrade(i, i + 1, i + 1));
        const tradesB = Array.from({ length: n }, (_, i) => makeTrade(i, i + 1, 2 * (i + 1)));
        const artifacts = [
            makeArtifact("AAA+BBB", "AAA", "BBB", data, tradesA),
            makeArtifact("CCC+DDD", "CCC", "DDD", data, tradesB),
        ];
        const result = await runExposureRedundancyReport(() => loader(artifacts));

        const entry = result.topExitPnlCorrelations.find(
            (e) => (e.pairA === "AAA+BBB" && e.pairB === "CCC+DDD") || (e.pairA === "CCC+DDD" && e.pairB === "AAA+BBB"),
        );
        expect(entry, "correlation entry must exist").to.not.equal(undefined);
        expect(entry!.overlap).to.equal(n);
        expect(entry!.correlation).to.be.closeTo(1.0, 1e-9);
    });

    it("returns correlation = null and overlap = 0 for two pairs with no trade-time overlap", async () => {
        // Disjoint exit-time ranges -> the sparse join finds nothing. Intent:
        // absence of overlap is reported as null + overlap=0, NOT fabricated.
        const n = MIN_TRADE_OVERLAP + 2;
        const data = makeCandles(n + 2, (i) => 100 + i);
        const startA = 1_700_000_000;
        const startB = startA + 1_000 * DAY; // 1000 days later — no shared exit keys
        const tradesA = Array.from({ length: n }, (_, i) => makeTrade(i, i + 1, i + 1, startA));
        const tradesB = Array.from({ length: n }, (_, i) => makeTrade(i, i + 1, i + 1, startB));
        const artifacts = [
            makeArtifact("AAA+BBB", "AAA", "BBB", data, tradesA),
            makeArtifact("CCC+DDD", "CCC", "DDD", data, tradesB),
        ];
        const result = await runExposureRedundancyReport(() => loader(artifacts));

        // The pair still appears in the (sorted) list but with null correlation.
        const entry = result.topExitPnlCorrelations.find(
            (e) => (e.pairA === "AAA+BBB" && e.pairB === "CCC+DDD") || (e.pairA === "CCC+DDD" && e.pairB === "AAA+BBB"),
        );
        expect(entry, "entry must be present even with zero overlap").to.not.equal(undefined);
        expect(entry!.overlap).to.equal(0);
        expect(entry!.correlation).to.equal(null);
    });

    it("sorts valid exit-P&L correlations ahead of insufficient-overlap entries", async () => {
        // Regression: null used to become abs(-1), which ranked it as a perfect
        // correlation and made the report say "insufficient" despite valid
        // relationships existing later in the full list.
        const n = MIN_TRADE_OVERLAP + 5;
        const data = makeCandles(n + 2, (i) => 100 + i);
        const sharedStart = 1_700_000_000;
        const disjointStart = sharedStart + 1_000 * DAY;
        const tradesA = Array.from({ length: n }, (_, i) => makeTrade(i, i + 1, i + 1, sharedStart));
        const tradesB = Array.from({ length: n }, (_, i) => makeTrade(i, i + 1, 2 * (i + 1), sharedStart));
        const tradesC = Array.from({ length: n }, (_, i) => makeTrade(i, i + 1, i + 1, disjointStart));
        const artifacts = [
            makeArtifact("AAA+BBB", "AAA", "BBB", data, tradesA),
            makeArtifact("CCC+DDD", "CCC", "DDD", data, tradesB),
            makeArtifact("EEE+FFF", "EEE", "FFF", data, tradesC),
        ];

        const result = await runExposureRedundancyReport(() => loader(artifacts));

        expect(result.topExitPnlCorrelations[0]!.correlation).to.be.closeTo(1, 1e-9);
        expect(result.reportLines.find((line) => line.startsWith("EXIT_PNL_CORR"))).to.not.contain("insufficient");
    });

    it("counts only positive correlation as redundancy and reports negative correlation separately", async () => {
        const n = MIN_TRADE_OVERLAP + 5;
        const data = makeCandles(n + 2, (i) => 100 + i);
        const tradesA = Array.from({ length: n }, (_, i) => makeTrade(i, i + 1, i + 1));
        const tradesPositive = Array.from({ length: n }, (_, i) => makeTrade(i, i + 1, 2 * (i + 1)));
        const tradesNegative = Array.from({ length: n }, (_, i) => makeTrade(i, i + 1, -2 * (i + 1)));
        const artifacts = [
            makeArtifact("AAA+BBB", "AAA", "BBB", data, tradesA),
            makeArtifact("CCC+DDD", "CCC", "DDD", data, tradesPositive),
            makeArtifact("EEE+FFF", "EEE", "FFF", data, tradesNegative),
        ];

        const result = await runExposureRedundancyReport(() => loader(artifacts));
        const redundancy = result.reportLines.find((line) => line.startsWith("REDUNDANCY"));
        const diversification = result.reportLines.find((line) => line.startsWith("DIVERSIFICATION"));

        expect(redundancy).to.contain("1 high-positive");
        expect(redundancy).to.contain("involve 2 pairs");
        expect(diversification).to.contain("2 high-negative");
    });

    it("excludes a pair-pair from ratio correlation when bar overlap is below the minimum", async () => {
        // Two pairs on entirely disjoint timelines -> 0 overlapping bars. The
        // ratio-correlation entry must be null, not a fabricated number.
        const shortData = makeCandles(50, (i) => 100 + i, 1_700_000_000);
        const otherData = makeCandles(50, (i) => 200 - i, 1_800_000_000); // disjoint timeline
        const artifacts = [
            makeArtifact("AAA+BBB", "AAA", "BBB", shortData, []),
            makeArtifact("CCC+DDD", "CCC", "DDD", otherData, []),
        ];
        const result = await runExposureRedundancyReport(() => loader(artifacts));

        const entry = result.topRatioCorrelations.find(
            (e) => (e.pairA === "AAA+BBB" && e.pairB === "CCC+DDD") || (e.pairA === "CCC+DDD" && e.pairB === "AAA+BBB"),
        );
        expect(entry).to.not.equal(undefined);
        expect(entry!.overlapBars).to.equal(0);
        expect(entry!.correlation).to.equal(null);
    });

    it("computes a ratio correlation when bar overlap meets the minimum", async () => {
        // Close-to-close returns correlate at exactly 1.0 only when the two
        // return series are proportional AND varying (a constant return series
        // has zero variance -> Pearson undefined). Make B's close exactly 2x
        // A's close at every bar while A wanders -> identical, varying returns.
        const bars = MIN_RATIO_BAR_OVERLAP + 20;
        const wander = (i: number) => 100 + 10 * Math.sin(i / 3) + i * 0.1;
        const dataA = makeCandles(bars, wander, 1_700_000_000);
        const dataB = makeCandles(bars, (i) => 2 * wander(i), 1_700_000_000);
        const artifacts = [
            makeArtifact("AAA+BBB", "AAA", "BBB", dataA, []),
            makeArtifact("CCC+DDD", "CCC", "DDD", dataB, []),
        ];
        const result = await runExposureRedundancyReport(() => loader(artifacts));

        const entry = result.topRatioCorrelations.find(
            (e) => (e.pairA === "AAA+BBB" && e.pairB === "CCC+DDD") || (e.pairA === "CCC+DDD" && e.pairB === "AAA+BBB"),
        );
        expect(entry).to.not.equal(undefined);
        expect(entry!.overlapBars).to.equal(bars);
        expect(entry!.correlation).to.be.closeTo(1.0, 1e-9);
    });

    it("produces report lines with the documented section prefixes and no quality labels", async () => {
        const data = makeCandles(MIN_RATIO_BAR_OVERLAP + 5, (i) => 100 + i);
        const artifacts = [
            makeArtifact("AAA+BBB", "AAA", "BBB", data, []),
            makeArtifact("AAA+CCC", "AAA", "CCC", data, []),
        ];
        const result = await runExposureRedundancyReport(() => loader(artifacts));

        const text = result.reportLines.join("\n");
        expect(text).to.contain("EXPOSURE");
        expect(text).to.contain("ASSETS");
        expect(text).to.contain("CONCENTRATION");
        expect(text).to.contain("NETWORK");
        expect(text).to.contain("EXIT_PNL_CORR");
        expect(text).to.contain("RATIO_CORR");
        expect(text).to.contain("REDUNDANCY");
        expect(text).to.contain("DIVERSIFICATION");
        // Descriptive-only contract: no quality labels.
        expect(text).to.not.match(/best|tradeable|avoid/i);
        // Report must never serialize NaN / Infinity.
        expect(text).to.not.contain("NaN");
        expect(text).to.not.contain("Infinity");
    });
});
