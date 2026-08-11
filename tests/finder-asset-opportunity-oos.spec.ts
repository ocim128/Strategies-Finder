import { expect } from "chai";
import { describe, it } from "node:test";
import {
    calculateFinderAssetOosAverageHorizonMetrics,
    calculateFinderAssetOosSignalMetrics,
    DEFAULT_FINDER_ASSET_OOS_HORIZONS,
    MAX_FINDER_ASSET_OOS_BATCH_VALUES,
    MAX_FINDER_ASSET_OOS_VALUE,
    normalizeFinderAssetOosBatchHoldoutRange,
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
        expect(capped.error).to.match(/at most 100 holdout values/);
        const exact = normalizeFinderAssetOosBatchHoldoutRange(1, MAX_FINDER_ASSET_OOS_BATCH_VALUES);
        expect(exact.error).to.equal(null);
        expect(exact.start).to.equal(1);
        expect(exact.end).to.equal(MAX_FINDER_ASSET_OOS_BATCH_VALUES);
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
