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
        // MAX_CACHE_ENTRIES in lib/data/data-cache.ts is 64; keep this in sync.
        for (let index = 0; index < 65; index += 1) {
            const key = `SYMBOL${index}:1m`;
            cache.set(key, [candle(index)], "test");
            cache.syncAtByKey.set(key, index);
        }

        assert.equal(cache.size, 64);
        assert.equal(cache.get("SYMBOL0:1m"), undefined);
        assert.equal(cache.syncAtByKey.has("SYMBOL0:1m"), false);
    });

    it("stores cache-entry metadata and clears it on unguarded updates", () => {
        const cache = new DataCache();

        cache.set("BTCUSDT:1m", [candle(1)], "test", {
            sanitizedFor: "binance|1m",
            contiguous: true,
            contiguousFor: "binance|1m",
            lastBarTime: 60,
        });

        assert.equal(cache.get("BTCUSDT:1m")?.sanitizedFor, "binance|1m");
        assert.equal(cache.get("BTCUSDT:1m")?.contiguous, true);

        cache.updateCandles("BTCUSDT:1m", [candle(2)]);

        const entry = cache.get("BTCUSDT:1m");
        assert.equal(entry?.sanitizedFor, undefined);
        assert.equal(entry?.contiguous, undefined);
        assert.equal(entry?.contiguousFor, undefined);
        assert.equal(entry?.lastBarTime, undefined);
    });
});

describe("DataCache retained-point budget", () => {
    const candles = (from: number, count: number): OHLCVData[] =>
        Array.from({ length: count }, (_, index) => candle(from + index));

    it("evicts the oldest entry when the point budget is exceeded", () => {
        const cache = new DataCache({ maxPoints: 10 });
        cache.set("A", candles(1, 4), "test");
        cache.syncAtByKey.set("A", 1);
        cache.set("B", candles(5, 4), "test");
        cache.syncAtByKey.set("B", 2);
        assert.equal(cache.points, 8);

        cache.set("C", candles(9, 4), "test");
        cache.syncAtByKey.set("C", 3);

        // A (oldest) is evicted first; B and C remain within the budget.
        assert.equal(cache.get("A"), undefined);
        assert.deepEqual([...cache.syncAtByKey.keys()], ["B", "C"]);
        assert.equal(cache.size, 2);
        assert.equal(cache.points, 8);
        assert.equal(cache.evictions, 1);
    });

    it("reaccounts replacement and explicit updates of an existing key", () => {
        const cache = new DataCache({ maxPoints: 10 });
        cache.set("A", candles(1, 6), "test");
        cache.set("B", candles(7, 2), "test");
        assert.equal(cache.points, 8);

        cache.set("A", candles(100, 3), "test");
        assert.equal(cache.points, 5);

        cache.updateCandles("A", candles(200, 9), {});
        // The updated entry (9 points) plus B (2) exceeds the budget, so B is
        // evicted and A alone remains.
        assert.equal(cache.get("B"), undefined);
        assert.equal(cache.points, 9);
        assert.equal(cache.evictions, 1);
    });

    it("tracks in-place array growth and shrink via mutation notifications", () => {
        const cache = new DataCache({ maxPoints: 10 });
        const shared: OHLCVData[] = candles(1, 3);
        cache.set("A", shared, "test");
        cache.set("B", candles(50, 3), "test");
        assert.equal(cache.points, 6);

        // Stream push: the same array reference grows without a set() call.
        shared.push(candle(4));
        cache.notifyCandleArrayMutation("A");
        assert.equal(cache.points, 7);

        // Stream head eviction: the same array reference shrinks.
        shared.splice(0, 2);
        cache.notifyCandleArrayMutation("A");
        assert.equal(cache.points, 5);

        // A last-bar replace does not change the length: notifying is a no-op.
        cache.notifyCandleArrayMutation("A");
        assert.equal(cache.points, 5);
        assert.equal(cache.evictions, 0);
    });

    it("does not retain an oversized dataset but leaves the caller's array intact", () => {
        const cache = new DataCache({ maxPoints: 10 });
        const oversized = candles(1, 25);

        cache.set("A", oversized, "test");

        assert.equal(cache.get("A"), undefined);
        assert.equal(cache.size, 0);
        assert.equal(cache.points, 0);
        // Rejected before admission: nothing was evicted to make room.
        assert.equal(cache.evictions, 0);
        assert.equal(cache.syncAtByKey.has("A"), false);
        // The caller keeps its full dataset.
        assert.equal(oversized.length, 25);
    });

    it("keeps populated entries and their metadata when an oversized entry is rejected", () => {
        const cache = new DataCache({ maxPoints: 10 });
        cache.set("A", candles(1, 4), "test");
        cache.syncAtByKey.set("A", 1);
        cache.set("B", candles(5, 4), "test");
        cache.syncAtByKey.set("B", 2);
        // Touch A so B is the older entry; an eviction would have hit B.
        cache.get("A");

        const oversized = candles(100, 11);
        cache.set("C", oversized, "test");

        assert.equal(cache.get("C"), undefined);
        assert.deepEqual([...cache.syncAtByKey.keys()].sort(), ["A", "B"]);
        assert.equal(cache.points, 8);
        assert.equal(cache.evictions, 0);
        // Recency survived: the next overflowing admission evicts B, not A.
        cache.set("D", candles(200, 4), "test");
        assert.equal(cache.get("B"), undefined);
        assert.equal(cache.get("A")?.candles.length, 4);
        assert.equal(cache.syncAtByKey.has("A"), true);
    });

    it("admits an entry exactly at the remaining budget without eviction", () => {
        const cache = new DataCache({ maxPoints: 10 });
        cache.set("A", candles(1, 4), "test");
        cache.set("B", candles(5, 4), "test");

        cache.set("C", candles(9, 2), "test");

        assert.equal(cache.size, 3);
        assert.equal(cache.points, 10);
        assert.equal(cache.evictions, 0);
    });

    it("cleans prewritten metadata when a never-admitted oversized key is rejected", () => {
        const cache = new DataCache({ maxPoints: 10 });
        cache.set("A", candles(1, 4), "test");
        cache.syncAtByKey.set("A", 1);
        // registerImportedData stamps sync time BEFORE the admission attempt,
        // so a rejected oversized key starts with metadata already present.
        cache.syncAtByKey.set("C", 3);

        cache.set("C", candles(100, 11), "test");

        assert.equal(cache.syncAtByKey.has("C"), false, "no orphan sync metadata may survive rejection");
        assert.equal(cache.get("C"), undefined);
        // Rejecting a never-admitted key is not an eviction of a retained entry.
        assert.equal(cache.evictions, 0);
        // Unrelated entries, their recency, and their timestamps are untouched.
        assert.equal(cache.get("A")?.candles.length, 4);
        assert.equal(cache.syncAtByKey.get("A"), 1);
        assert.equal(cache.points, 4);
    });

    it("discards an oversized replacement without flushing unrelated entries", () => {
        const cache = new DataCache({ maxPoints: 10 });
        cache.set("A", candles(1, 4), "test");
        cache.syncAtByKey.set("A", 1);
        cache.set("B", candles(5, 4), "test");
        cache.syncAtByKey.set("B", 2);

        cache.set("B", candles(100, 11), "test");

        assert.equal(cache.get("B"), undefined);
        assert.equal(cache.syncAtByKey.has("B"), false);
        assert.equal(cache.get("A")?.candles.length, 4);
        assert.equal(cache.syncAtByKey.has("A"), true);
        assert.equal(cache.points, 4);
        assert.equal(cache.evictions, 1);
    });

    it("discards an entry that an explicit update grows beyond the whole budget", () => {
        const cache = new DataCache({ maxPoints: 10 });
        cache.set("A", candles(1, 4), "test");
        cache.syncAtByKey.set("A", 1);
        cache.set("B", candles(5, 4), "test");
        cache.syncAtByKey.set("B", 2);

        cache.updateCandles("B", candles(100, 12), { sanitizedFor: "binance|1m" });

        assert.equal(cache.get("B"), undefined);
        assert.equal(cache.syncAtByKey.has("B"), false);
        assert.equal(cache.get("A")?.candles.length, 4);
        assert.equal(cache.points, 4);
        assert.equal(cache.evictions, 1);
    });

    it("discards an entry whose notified in-place growth exceeds the whole budget", () => {
        const cache = new DataCache({ maxPoints: 10 });
        const shared: OHLCVData[] = candles(1, 4);
        cache.set("A", shared, "test");
        cache.syncAtByKey.set("A", 1);
        cache.set("B", candles(5, 4), "test");
        cache.syncAtByKey.set("B", 2);

        // Stream push mutates the shared array in place beyond the budget.
        for (let index = 0; index < 8; index += 1) shared.push(candle(100 + index));
        cache.notifyCandleArrayMutation("A");

        assert.equal(cache.get("A"), undefined);
        assert.equal(cache.syncAtByKey.has("A"), false);
        assert.equal(cache.get("B")?.candles.length, 4);
        assert.equal(cache.points, 4);
        assert.equal(cache.evictions, 1);
        // The caller's array is untouched by the discard.
        assert.equal(shared.length, 12);
    });

    it("clear resets points, accounting, and eviction statistics", () => {
        const cache = new DataCache({ maxPoints: 10 });
        cache.set("A", candles(1, 8), "test");
        cache.set("B", candles(9, 8), "test");
        assert.equal(cache.evictions, 1);

        cache.clear();

        assert.equal(cache.size, 0);
        assert.equal(cache.points, 0);
        assert.equal(cache.evictions, 0);
        assert.equal(cache.syncAtByKey.size, 0);
    });

    it("supports disabling the point budget so entry count alone applies", () => {
        const cache = new DataCache({ maxPoints: Infinity });
        for (let index = 0; index < 65; index += 1) {
            cache.set(`K${index}`, candles(index, 30_000), "test");
        }

        assert.equal(cache.size, 64);
        assert.equal(cache.get("K0"), undefined);
        assert.equal(cache.points, 64 * 30_000);
        assert.equal(cache.evictions, 1);
    });

    it("keeps accounted lengths independent of later external array mutation", () => {
        const cache = new DataCache({ maxPoints: 100 });
        const shared: OHLCVData[] = candles(1, 5);
        cache.set("A", shared, "test");

        // Without a notification the total stays at the accounted length even
        // though the live array grew; reconcileTest reflects the policy that
        // stream paths must notify explicitly.
        shared.push(candle(9));
        assert.equal(cache.points, 5);

        cache.notifyCandleArrayMutation("A");
        assert.equal(cache.points, 6);
    });
});
