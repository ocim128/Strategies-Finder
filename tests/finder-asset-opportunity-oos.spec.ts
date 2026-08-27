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

    it("uses the documented three-horizon default and rejects incomplete settings", () => {
        expect(normalizeFinderAssetOosHorizons(undefined)).to.deep.equal([...DEFAULT_FINDER_ASSET_OOS_HORIZONS]);
        expect(normalizeFinderAssetOosHorizons("1,3,5")).to.deep.equal([1, 3, 5]);
        expect(normalizeFinderAssetOosHorizons([1, 3])).to.deep.equal([...DEFAULT_FINDER_ASSET_OOS_HORIZONS]);
        expect(normalizeFinderAssetOosHorizons([1, 1, 5])).to.deep.equal([...DEFAULT_FINDER_ASSET_OOS_HORIZONS]);
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
    });
});
