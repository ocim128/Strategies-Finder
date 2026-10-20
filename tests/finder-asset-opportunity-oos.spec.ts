import { expect } from "chai";
import { describe, it } from "node:test";
import {
    calculateFinderAssetOosAverageHorizonMetrics,
    calculateFinderAssetOosNextExitMetrics,
    calculateFinderAssetOosSignalMetrics,
    DEFAULT_FINDER_ASSET_OOS_HORIZONS,
    MAX_FINDER_ASSET_OOS_BATCH_VALUES,
    MAX_FINDER_ASSET_OOS_VALUE,
    normalizeFinderAssetEvalLastBars,
    normalizeFinderAssetOosBatchHoldoutRange,
    normalizeFinderAssetOosMeasurementMode,
    normalizeFinderAssetOosHorizons,
} from "../lib/finder/finder-asset-opportunity-oos";
import type { OHLCVData, Time } from "../lib/types/strategies";

function makeCandles(closes: number[]): OHLCVData[] {
    return closes.map((close, index) => ({
        time: (1_700_000_000 + index * 300) as Time,
        open: close,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1,
    }));
}

describe("Asset Opportunity batch holdout range", () => {
    it("accepts an inclusive ordered range of positive integers", () => {
        expect(normalizeFinderAssetOosBatchHoldoutRange(2, 4)).to.deep.equal({ start: 2, end: 4, error: null });
        expect(normalizeFinderAssetOosBatchHoldoutRange("2", "4")).to.deep.equal({ start: 2, end: 4, error: null });
        expect(normalizeFinderAssetOosBatchHoldoutRange(7, 7)).to.deep.equal({ start: 7, end: 7, error: null });
    });

    it("rejects a one-value range when disabled-style sentinel 0 is used", () => {
        // 0 is the single-run "no holdout" sentinel and must not become a
        // batch iteration value.
        expect(normalizeFinderAssetOosBatchHoldoutRange(0, 5).error).to.match(/positive integer/);
        expect(normalizeFinderAssetOosBatchHoldoutRange(1, 0).error).to.match(/positive integer/);
    });

    it("rejects non-integers, negatives, and over-cap values", () => {
        expect(normalizeFinderAssetOosBatchHoldoutRange("abc", 5).error).to.match(/positive integer/);
        expect(normalizeFinderAssetOosBatchHoldoutRange(1.5, 5).error).to.match(/positive integer/);
        expect(normalizeFinderAssetOosBatchHoldoutRange(-3, 5).error).to.match(/positive integer/);
        expect(normalizeFinderAssetOosBatchHoldoutRange(1, MAX_FINDER_ASSET_OOS_VALUE + 1).error).to.match(/positive integer/);
        expect(normalizeFinderAssetOosBatchHoldoutRange(undefined, undefined).error).to.match(/positive integer/);
    });

    it("rejects a reversed range (start > end)", () => {
        expect(normalizeFinderAssetOosBatchHoldoutRange(5, 2).error).to.match(/must not exceed/);
    });

    it("caps the inclusive range at the batch value limit", () => {
        const capped = normalizeFinderAssetOosBatchHoldoutRange(1, MAX_FINDER_ASSET_OOS_BATCH_VALUES + 1);
        expect(capped.error).to.match(new RegExp(`at most ${MAX_FINDER_ASSET_OOS_BATCH_VALUES} holdout values`));
        const exact = normalizeFinderAssetOosBatchHoldoutRange(1, MAX_FINDER_ASSET_OOS_BATCH_VALUES);
        expect(exact.error).to.equal(null);
        expect(exact.start).to.equal(1);
        expect(exact.end).to.equal(MAX_FINDER_ASSET_OOS_BATCH_VALUES);
    });
});

describe("Asset Opportunity evaluation window normalization", () => {
    it("treats 0, absent, and invalid values as the disabled sentinel", () => {
        expect(normalizeFinderAssetEvalLastBars(0)).to.equal(0);
        expect(normalizeFinderAssetEvalLastBars(undefined)).to.equal(0);
        expect(normalizeFinderAssetEvalLastBars(-1000)).to.equal(0);
        expect(normalizeFinderAssetEvalLastBars("abc")).to.equal(0);
        expect(normalizeFinderAssetEvalLastBars(Number.NaN)).to.equal(0);
        expect(normalizeFinderAssetEvalLastBars(null)).to.equal(0);
    });

    it("rounds non-integers and clamps to the shared asset cap", () => {
        expect(normalizeFinderAssetEvalLastBars(1000)).to.equal(1000);
        expect(normalizeFinderAssetEvalLastBars("1500")).to.equal(1500);
        expect(normalizeFinderAssetEvalLastBars(999.6)).to.equal(1000);
        expect(normalizeFinderAssetEvalLastBars(MAX_FINDER_ASSET_OOS_VALUE + 1)).to.equal(MAX_FINDER_ASSET_OOS_VALUE);
    });
});

describe("Asset Opportunity fixed-horizon OOS metrics", () => {
    it("averages each forward-validation horizon across the displayed results", () => {
        expect(calculateFinderAssetOosAverageHorizonMetrics([
            {
                ignoreLastBars: 2,
                horizons: [
                    { bars: 5, pnlPercent: 10, averagePnlPercent: 8, winRatePercent: 100, sampleSize: 2 },
                    { bars: 12, pnlPercent: 20, averagePnlPercent: 18, winRatePercent: 100, sampleSize: 2 },
                ],
            },
            {
                ignoreLastBars: 2,
                horizons: [
                    { bars: 5, pnlPercent: 0, averagePnlPercent: 2, winRatePercent: 50, sampleSize: 2 },
                    { bars: 12, pnlPercent: -10, averagePnlPercent: -8, winRatePercent: 0, sampleSize: 2 },
                ],
            },
            undefined,
        ])).to.deep.equal([
            { bars: 5, averagePnlPercent: 5, sampleSize: 2 },
            { bars: 12, averagePnlPercent: 5, sampleSize: 2 },
        ]);
    });

    it("falls back to the documented default only when no usable horizon remains", () => {
        expect(normalizeFinderAssetOosHorizons(undefined)).to.deep.equal([...DEFAULT_FINDER_ASSET_OOS_HORIZONS]);
        expect(normalizeFinderAssetOosHorizons("")).to.deep.equal([...DEFAULT_FINDER_ASSET_OOS_HORIZONS]);
        expect(normalizeFinderAssetOosHorizons("abc")).to.deep.equal([...DEFAULT_FINDER_ASSET_OOS_HORIZONS]);
        expect(normalizeFinderAssetOosHorizons("0, -2")).to.deep.equal([...DEFAULT_FINDER_ASSET_OOS_HORIZONS]);
        expect(normalizeFinderAssetOosHorizons([])).to.deep.equal([...DEFAULT_FINDER_ASSET_OOS_HORIZONS]);
    });

    it("honors every entered horizon instead of forcing three", () => {
        // Regression: a two-value entry used to fail the "exactly three"
        // check and silently became 1,3,5 in results and archives.
        expect(normalizeFinderAssetOosHorizons("12,23")).to.deep.equal([12, 23]);
        expect(normalizeFinderAssetOosHorizons([12, 23])).to.deep.equal([12, 23]);
        expect(normalizeFinderAssetOosHorizons("1")).to.deep.equal([1]);
        expect(normalizeFinderAssetOosHorizons("1,3,5")).to.deep.equal([1, 3, 5]);
        expect(normalizeFinderAssetOosHorizons("1,5,12,23,48")).to.deep.equal([1, 5, 12, 23, 48]);
        expect(normalizeFinderAssetOosHorizons("1, 36, 96")).to.deep.equal([1, 36, 96]);
        // Ordering is ascending regardless of typing order.
        expect(normalizeFinderAssetOosHorizons("23, 12")).to.deep.equal([12, 23]);
        // Duplicates collapse; stray tokens are dropped rather than blanking
        // the whole field back to the default.
        expect(normalizeFinderAssetOosHorizons("1,1,5")).to.deep.equal([1, 5]);
        expect(normalizeFinderAssetOosHorizons("12, abc, 23")).to.deep.equal([12, 23]);
        expect(normalizeFinderAssetOosHorizons("12, 23.5")).to.deep.equal([12]);
        expect(normalizeFinderAssetOosHorizons(`12, ${MAX_FINDER_ASSET_OOS_VALUE + 1}`)).to.deep.equal([12]);
        // Full-width comma from a non-US keyboard is a separator too.
        expect(normalizeFinderAssetOosHorizons("12\uFF0C23")).to.deep.equal([12, 23]);
    });

    it("scores one visible-boundary signal against only the hidden future", () => {
        const candles = makeCandles([100, 101, 102, 100, 110, 90, 95]);
        const metrics = calculateFinderAssetOosSignalMetrics({
            candles,
            signalIndex: 3,
            entryPrice: 100,
            direction: "long",
            ignoreLastBars: 4,
            horizons: [1, 3, 5],
        });

        expect(metrics.ignoreLastBars).to.equal(4);
        expect(metrics.horizons).to.deep.equal([
            { bars: 1, pnlPercent: 10, averagePnlPercent: 10, winRatePercent: 100, sampleSize: 1 },
            { bars: 3, pnlPercent: -5, averagePnlPercent: -5, winRatePercent: 0, sampleSize: 1 },
            // Horizon 5 exceeds the 4-bar holdout: measured ongoing at the
            // last available candle (close 95) instead of discarded.
            { bars: 5, pnlPercent: -5, averagePnlPercent: -5, winRatePercent: 0, sampleSize: 1, ongoing: true },
        ]);
    });

    it("keeps horizons unavailable when no forward candle exists after the signal", () => {
        const candles = makeCandles([100, 101, 102]);
        const metrics = calculateFinderAssetOosSignalMetrics({
            candles,
            signalIndex: 2,
            entryPrice: 102,
            direction: "long",
            ignoreLastBars: 0,
            horizons: [1, 3, 5],
        });

        // The signal sits on the last candle: no forward candle exists, so
        // nothing is measured and nothing is marked ongoing.
        expect(metrics.horizons).to.deep.equal([
            { bars: 1, pnlPercent: null, averagePnlPercent: null, winRatePercent: null, sampleSize: 0 },
            { bars: 3, pnlPercent: null, averagePnlPercent: null, winRatePercent: null, sampleSize: 0 },
            { bars: 5, pnlPercent: null, averagePnlPercent: null, winRatePercent: null, sampleSize: 0 },
        ]);
    });

    it("measures exactly the horizons a two-value setting lists", () => {
        // 30 rising closes; the entry sits on candle 4, so candle 16 is the
        // 12-bar target and candle 27 the 23-bar target.
        const candles = makeCandles(Array.from({ length: 30 }, (_, index) => 100 + index));
        const metrics = calculateFinderAssetOosSignalMetrics({
            candles,
            signalIndex: 4,
            entryPrice: 100,
            direction: "long",
            ignoreLastBars: 5,
            horizons: [12, 23],
        });

        // Regression: 12,23 must not become 1,3,5.
        expect(metrics.horizons.map((horizon) => horizon.bars)).to.deep.equal([12, 23]);
        expect(metrics.horizons[0]!.pnlPercent).to.be.closeTo(16, 1e-9);
        expect(metrics.horizons[1]!.pnlPercent).to.be.closeTo(27, 1e-9);
        expect(metrics.horizons.every((horizon) => horizon.ongoing === undefined)).to.equal(true);
    });

    it("leaves leg-basis horizons unavailable when the leg lacks those timestamps", () => {
        const candles = makeCandles([100, 101, 102, 100, 110, 90, 95]);
        const legCandles = makeCandles([100, 100, 100, 100, 100]); // only through index 4
        const metrics = calculateFinderAssetOosSignalMetrics({
            candles,
            horizonCandlesByTime: new Map(legCandles.map((bar) => [Number(bar.time), bar])),
            signalIndex: 3,
            entryPrice: 100,
            direction: "long",
            ignoreLastBars: 4,
            horizons: [1, 3, 5],
        });

        // Horizon 1 resolves in the leg map; horizons 3 and 5 need the pair's
        // later timestamps (index 6, including the ongoing fallback target),
        // which the short leg map lacks, so they stay unavailable.
        expect(metrics.horizons).to.deep.equal([
            { bars: 1, pnlPercent: 0, averagePnlPercent: 0, winRatePercent: 0, sampleSize: 1 },
            { bars: 3, pnlPercent: null, averagePnlPercent: null, winRatePercent: null, sampleSize: 0 },
            { bars: 5, pnlPercent: null, averagePnlPercent: null, winRatePercent: null, sampleSize: 0 },
        ]);
    });
});

describe("Asset Opportunity next-exit OOS metrics", () => {
    it("defaults invalid measurement modes to fixed horizons", () => {
        expect(normalizeFinderAssetOosMeasurementMode(undefined)).to.equal("fixed_horizon");
        expect(normalizeFinderAssetOosMeasurementMode("legacy")).to.equal("fixed_horizon");
        expect(normalizeFinderAssetOosMeasurementMode("next_exit")).to.equal("next_exit");
    });

    it("reports the first matching exit with realized engine PnL", () => {
        const candles = makeCandles([100, 101, 102, 103]);
        const entryTime = candles[1]!.time;
        const exitTime = candles[2]!.time;
        const metrics = calculateFinderAssetOosNextExitMetrics({
            candles,
            boundaryEntryTime: entryTime,
            direction: "long",
            ignoreLastBars: 2,
            trades: [
                {
                    id: 1,
                    type: "long",
                    entryTime,
                    entryPrice: 101,
                    exitTime,
                    exitPrice: 102,
                    pnl: 9.5,
                    pnlPercent: 9.5,
                    size: 1,
                    exitReason: "take_profit",
                },
                {
                    id: 2,
                    type: "long",
                    entryTime,
                    entryPrice: 101,
                    exitTime: candles[3]!.time,
                    exitPrice: 103,
                    pnl: 19,
                    pnlPercent: 19,
                    size: 1,
                    exitReason: "signal",
                },
            ],
        });

        expect(metrics).to.deep.equal({
            ignoreLastBars: 2,
            status: "exited",
            pnlPercent: 9.5,
            exitReason: "take_profit",
            unavailableReason: null,
            barsHeld: 1,
            exitTime,
        });
    });

    it("censors end-of-data and does not invent a PnL observation", () => {
        const candles = makeCandles([100, 101, 102]);
        const metrics = calculateFinderAssetOosNextExitMetrics({
            candles,
            boundaryEntryTime: candles[1]!.time,
            direction: "short",
            ignoreLastBars: 1,
            trades: [{
                id: 1,
                type: "short",
                entryTime: candles[1]!.time,
                entryPrice: 101,
                exitTime: candles[2]!.time,
                exitPrice: 102,
                pnl: -1,
                pnlPercent: -1,
                size: 1,
                exitReason: "end_of_data",
            }],
        });

        expect(metrics.status).to.equal("censored");
        expect(metrics.pnlPercent).to.equal(null);
        expect(metrics.exitReason).to.equal("end_of_data");
        expect(metrics.unavailableReason).to.equal(null);
        expect(metrics.barsHeld).to.equal(1);
    });

    it("returns unavailable when the boundary entry is not present", () => {
        const metrics = calculateFinderAssetOosNextExitMetrics({
            candles: makeCandles([100, 101]),
            boundaryEntryTime: 1_600_000_000 as Time,
            direction: "long",
            ignoreLastBars: 1,
            trades: [],
        });
        expect(metrics.status).to.equal("unavailable");
        expect(metrics.pnlPercent).to.equal(null);
        expect(metrics.exitReason).to.equal(null);
        expect(metrics.unavailableReason).to.equal("no_boundary_trade");
    });

    it("distinguishes a matching trade without an exit reason", () => {
        const candles = makeCandles([100, 101, 102]);
        const metrics = calculateFinderAssetOosNextExitMetrics({
            candles,
            boundaryEntryTime: candles[1]!.time,
            direction: "long",
            ignoreLastBars: 1,
            trades: [{
                id: 1,
                type: "long",
                entryTime: candles[1]!.time,
                entryPrice: 101,
                exitTime: candles[2]!.time,
                exitPrice: 102,
                pnl: 1,
                pnlPercent: 1,
                size: 1,
            }],
        });

        expect(metrics.status).to.equal("unavailable");
        expect(metrics.unavailableReason).to.equal("missing_exit_reason");
    });

    it("preserves the runner's explicit replay-failure classification", () => {
        const metrics = calculateFinderAssetOosNextExitMetrics({
            candles: makeCandles([100, 101]),
            boundaryEntryTime: null,
            direction: "long",
            ignoreLastBars: 1,
            trades: [],
            unavailableReason: "replay_error",
        });

        expect(metrics.status).to.equal("unavailable");
        expect(metrics.unavailableReason).to.equal("replay_error");
    });
});
