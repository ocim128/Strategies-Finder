import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectBestNonBinanceLocalCandidate } from "../lib/data/data-persistence";
import type { OHLCVData } from "../lib/types/strategies";

function candles(count: number): OHLCVData[] {
    return Array.from({ length: count }, (_, index) => ({
        time: index + 1,
        open: index + 1,
        high: index + 2,
        low: index,
        close: index + 1.5,
        volume: 1000 + index,
    }));
}

describe("non-Binance local data priority", () => {
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
