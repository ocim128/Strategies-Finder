import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DataCache } from "../lib/data/data-cache";
import type { OHLCVData } from "../lib/types";

function candle(time: number): OHLCVData {
    return {
        time: time as OHLCVData["time"],
        open: time,
        high: time,
        low: time,
        close: time,
        volume: 0,
    };
}

describe("DataCache metadata lifecycle", () => {
    it("removes sync metadata when a cache key is deleted or invalidated", () => {
        const cache = new DataCache();
        cache.set("BTCUSDT:1m", [candle(1)], "test");
        cache.set("ETHUSDT:1m", [candle(2)], "test");
        cache.syncAtByKey.set("BTCUSDT:1m", 100);
        cache.syncAtByKey.set("ETHUSDT:1m", 200);

        assert.equal(cache.delete("BTCUSDT:1m"), true);
        assert.equal(cache.syncAtByKey.has("BTCUSDT:1m"), false);

        cache.invalidate("ETHUSDT:1m");
        assert.equal(cache.syncAtByKey.has("ETHUSDT:1m"), false);
    });

    it("removes sync metadata when LRU eviction removes the oldest entry", () => {
        const cache = new DataCache();

        // Insert MAX_CACHE_ENTRIES + 1 entries to trigger LRU eviction of the oldest.
        for (let index = 0; index < 257; index += 1) {
            const key = `SYMBOL${index}:1m`;
            cache.set(key, [candle(index)], "test");
            cache.syncAtByKey.set(key, index);
        }

        assert.equal(cache.size, 256);
        assert.equal(cache.get("SYMBOL0:1m"), undefined);
        assert.equal(cache.syncAtByKey.has("SYMBOL0:1m"), false);
    });
});
