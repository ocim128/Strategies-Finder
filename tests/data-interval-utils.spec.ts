import { expect } from "chai";
import { describe, it } from "node:test";
import {
    estimateBybitSeedOverlayBars,
    getImportStorageIntervals,
    getStorageInterval,
    isIntervalAlignedTime,
    sliceCandlesToLookback,
} from "./lib/data/data-interval-utils";

describe("Data interval utils", () => {
    it("normalizes 2h storage keys to the single supported interval", () => {
        expect(getImportStorageIntervals("2h")).to.deep.equal(["2h"]);
        expect(getImportStorageIntervals("2H")).to.deep.equal(["2h"]);
        expect(getStorageInterval("2H")).to.equal("2h");
    });

    it("keeps interval alignment logic outside the manager", () => {
        expect(isIntervalAlignedTime(0, "2h")).to.equal(true);
        expect(isIntervalAlignedTime(3600, "2h")).to.equal(false);
        expect(isIntervalAlignedTime(86400, "1d")).to.equal(true);
    });

    it("slices lookback and estimates bybit overlay bars deterministically", () => {
        const candles = [
            { time: 1000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
            { time: 1060, open: 2, high: 2, low: 2, close: 2, volume: 2 },
            { time: 1120, open: 3, high: 3, low: 3, close: 3, volume: 3 },
        ];

        expect(sliceCandlesToLookback(candles, 2).map((candle) => candle.close)).to.deep.equal([2, 3]);
        expect(estimateBybitSeedOverlayBars("1m", candles, 1720)).to.equal(20);
    });
});
