import { expect } from "chai";
import { describe, it } from "node:test";
import {
    calculateFinderAssetOosAverageHorizonMetrics,
    calculateFinderAssetOosSignalMetrics,
    DEFAULT_FINDER_ASSET_OOS_HORIZONS,
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
