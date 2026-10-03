import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DataPersistence, selectBestNonBinanceLocalCandidate } from "../lib/data/data-persistence";
import type { OHLCVData, Time } from "../lib/types/strategies";

function candles(count: number): OHLCVData[] {
    return Array.from({ length: count }, (_, index) => ({
        time: (index + 1) as Time,
        open: index + 1,
        high: index + 2,
        low: index,
        close: index + 1.5,
        volume: 1000 + index,
    }));
}

describe("non-Binance local data priority", () => {
    it("filters IBKR daily imports before applying the requested bar limit", async () => {
        const data: OHLCVData[] = [
            { time: "2026-09-03", open: 12.89, high: 20.5, low: 12.7, close: 18.48, volume: 7598 },
            { time: "2026-09-04", open: 0.3696, high: 0.3696, low: 0.3696, close: 0.3696, volume: 0 },
            { time: "2026-09-08", open: 18.585, high: 20, low: 18.425, close: 19.99, volume: 7674 },
        ].map(bar => ({ ...bar, time: (Date.parse(String(bar.time)) / 1000) as Time }));
        let cached: OHLCVData[] = [];
        const result = await new DataPersistence().loadNonBinanceLocalData({
            symbol: "TANH\u2022", storageSymbol: "TANH\u2022", interval: "1d", storageInterval: "1d",
            provider: "ibkr-local", maxBars: 2, cacheKey: "TANH::1d", importedCandles: data,
            ctx: { syncAtByKey: new Map(), setCachedCandles: (_key, bars) => { cached = bars; } },
        });
        assert.equal(result?.source, "imported");
        assert.deepEqual(cached.map(bar => bar.open), [12.89, 18.585]);
        assert.deepEqual(result?.candles, cached);
    });

    it("prefers the longest non-imported candidate so short live overlays do not hide seed history", () => {
        const best = selectBestNonBinanceLocalCandidate([
            { source: "seed", candles: candles(500) },
            { source: "cache", candles: candles(400) },
            { source: "sqlite", candles: candles(50) },
        ]);

        assert.equal(best?.source, "seed");
        assert.equal(best?.candles.length, 500);
    });

    it("keeps explicit imported data ahead of longer persisted candidates", () => {
        const best = selectBestNonBinanceLocalCandidate([
            { source: "seed", candles: candles(500) },
            { source: "imported", candles: candles(50) },
        ]);

        assert.equal(best?.source, "imported");
        assert.equal(best?.candles.length, 50);
    });

    it("uses candle count only as a tie-breaker within the same source", () => {
        const best = selectBestNonBinanceLocalCandidate([
            { source: "cache", candles: candles(20) },
            { source: "cache", candles: candles(30) },
        ]);

        assert.equal(best?.source, "cache");
        assert.equal(best?.candles.length, 30);
    });

    it("does not reorder the caller-owned candidate array", () => {
        const candidates = [
            { source: "seed" as const, candles: candles(500) },
            { source: "sqlite" as const, candles: candles(50) },
            { source: "cache" as const, candles: candles(400) },
        ];

        selectBestNonBinanceLocalCandidate(candidates);

        assert.deepEqual(candidates.map((candidate) => candidate.source), ["seed", "sqlite", "cache"]);
    });
});
