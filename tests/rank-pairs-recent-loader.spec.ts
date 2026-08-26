import { expect } from "chai";
import { describe, it } from "node:test";
import { createRankPairsRecentLoader } from "../lib/rank-pairs/rank-pairs-recent-loader-core";
import type { OHLCVData } from "../lib/types/strategies";

function bars(count: number, offset = 0): OHLCVData[] {
    return Array.from({ length: count }, (_, index) => {
        const close = 100 + index / 100;
        return {
            time: ((index + offset) * 60) as OHLCVData["time"],
            open: close,
            high: close,
            low: close,
            close,
            volume: 1,
        };
    });
}

describe("rank-pairs recent loader cache", () => {
    it("loads the requested evaluation window plus holdout bars", async () => {
        const loader = createRankPairsRecentLoader(
            async () => bars(600),
        );

        const result = await loader.load("AAA+BBB", "1m", undefined, 250);

        expect(result).to.have.length(250);
    });

    it("deduplicates shared legs and reports bounded-cache eviction", async () => {
        const calls: string[] = [];
        const loader = createRankPairsRecentLoader(
            async (symbol, interval, requestedBars) => {
                calls.push(`${symbol}|${interval}|${requestedBars}`);
                return bars(400);
            },
            { legCacheMaxEntries: 2 },
        );

        await loader.load("AAA+BBB", "1m");
        await loader.load("AAA+CCC", "1m");

        expect(calls).to.have.length(3);
        expect(loader.getStats()).to.include({
            legHits: 1,
            legMisses: 3,
            legEvictions: 1,
            legCacheSize: 2,
            legCacheMaxEntries: 2,
        });
    });

    it("upgrades a shallow leg once and reuses the deep entry for later pairs", async () => {
        const calls: Array<{ symbol: string; requestedBars: number }> = [];
        let shallowRequestBars: number | null = null;
        const loader = createRankPairsRecentLoader(
            async (symbol, _interval, requestedBars) => {
                calls.push({ symbol, requestedBars });
                shallowRequestBars ??= requestedBars;
                const count = Math.max(200, Math.ceil(requestedBars * 0.25));
                if (requestedBars === shallowRequestBars) {
                    return bars(count, symbol.includes("BBB") ? count - 100 : 0);
                }
                return bars(count);
            },
            { legCacheMaxEntries: 8 },
        );

        const first = await loader.load("AAA+BBB", "1m");
        const callsAfterFirst = calls.length;
        const second = await loader.load("AAA+BBB", "1m");

        expect(first).to.have.length(200);
        expect(second).to.have.length(200);
        expect(callsAfterFirst).to.equal(4);
        expect(calls).to.have.length(4);
        expect(loader.getStats()).to.include({
            legMisses: 4,
            legUpgrades: 2,
            deepPairFallbacks: 1,
            networkFallbacks: 0,
        });
    });
});
