import { expect } from "chai";
import { describe, it } from "node:test";
import {
    estimateBybitSeedOverlayBars,
    getImportStorageIntervals,
    getStorageInterval,
    isIntervalAlignedTime,
    normalizeTradFiDailyCandles,
    normalizeTradFiDailySessionTime,
    sliceCandlesToLookback,
} from "../lib/data/data-interval-utils";
import type { OHLCVData, Time } from "../lib/types/strategies";

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
        const candles: OHLCVData[] = [
            { time: 1000 as Time, open: 1, high: 1, low: 1, close: 1, volume: 1 },
            { time: 1060 as Time, open: 2, high: 2, low: 2, close: 2, volume: 2 },
            { time: 1120 as Time, open: 3, high: 3, low: 3, close: 3, volume: 3 },
        ];

        expect(sliceCandlesToLookback(candles, 2).map((candle) => candle.close)).to.deep.equal([2, 3]);
        expect(estimateBybitSeedOverlayBars("1m", candles, 1720)).to.equal(20);
    });

    it("canonicalizes local TradFi daily seed and Bybit overlay timestamps to one session key", () => {
        const seedTime = Date.parse("2026-02-20T00:00:00-05:00") / 1000;
        const bybitOverlayTime = Date.parse("2026-02-19T22:00:00Z") / 1000;
        const sessionTime = Date.parse("2026-02-20T00:00:00Z") / 1000;

        expect(normalizeTradFiDailySessionTime(seedTime)).to.equal(sessionTime);
        expect(normalizeTradFiDailySessionTime(bybitOverlayTime)).to.equal(sessionTime);

        const normalized = normalizeTradFiDailyCandles([
            { time: seedTime as Time, open: 100, high: 110, low: 90, close: 105, volume: 1000 },
            { time: bybitOverlayTime as Time, open: 101, high: 111, low: 91, close: 106, volume: 0 },
        ], "1d");

        expect(normalized).to.have.length(1);
        expect(Number(normalized[0].time)).to.equal(sessionTime);
        expect(normalized[0].close).to.equal(106);
    });
});
