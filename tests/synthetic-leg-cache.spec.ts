import { expect } from "chai";
import { describe, it } from "node:test";
import {
    SyntheticLegCache,
    buildLegCacheKey,
    buildPairCacheKey,
} from "../lib/batch-backtest/synthetic-leg-cache";

/**
 * Guards the dedup contract that Batch Backtest relies on to avoid re-fetching
 * a shared synthetic leg (e.g. ZEC across a ZEC+* list) once per pair. The bug
 * this prevents: a 36-pair list referencing ZEC fired 36 ZEC fetches instead of
 * 1. The cache lives in a pure, dependency-free module so it can be tested in
 * isolation from the runtime data-manager graph.
 */
describe("SyntheticLegCache", () => {
    it("dedups concurrent in-flight requests for the same key to one producer call", async () => {
        const cache = new SyntheticLegCache<string>(8);
        let producerCalls = 0;
        const produce = (key: string): Promise<string> => {
            const p = new Promise<string>((resolve) => {
                producerCalls += 1;
                // Resolve on next tick so concurrent callers see no cached value yet.
                setTimeout(() => resolve(key), 5);
            });
            cache.set(key, p);
            return p;
        };

        const get = (key: string): Promise<string> => cache.get(key) ?? produce(key);

        // Fan out 10 concurrent requests for the SAME key while the first is
        // still in-flight. Only the first should reach the producer; the rest
        // must attach to the cached in-flight promise.
        const results = await Promise.all(Array.from({ length: 10 }, () => get("ZECUSDT|1m|50000")));

        expect(producerCalls, "shared leg must be fetched once, not once per caller").to.equal(1);
        expect(results.every((r) => r === "ZECUSDT|1m|50000")).to.equal(true);
    });

    it("counts one miss per unique key, not per request", async () => {
        const cache = new SyntheticLegCache<number>(8);
        const make = (key: string): Promise<number> => {
            const p = Promise.resolve(key.length);
            cache.set(key, p);
            return p;
        };
        const get = (key: string): Promise<number> => cache.get(key) ?? make(key);

        // 3 unique keys, each requested multiple times.
        await Promise.all([
            get("a"), get("a"), get("a"),
            get("bb"), get("bb"),
            get("ccc"),
        ]);

        expect(cache.missCount(), "one miss per unique key").to.equal(3);
    });

    it("serves subsequent (post-resolve) requests from cache without a new miss", async () => {
        const cache = new SyntheticLegCache<number>(4);
        const make = (key: string): Promise<number> => {
            const p = Promise.resolve(1);
            cache.set(key, p);
            return p;
        };
        const get = (key: string): Promise<number> => cache.get(key) ?? make(key);

        await get("x");           // miss
        await get("x");           // hit (cached resolved promise)
        await get("x");           // hit

        expect(cache.missCount()).to.equal(1);
    });

    it("evicts the least-recently-used entry when over capacity", async () => {
        const cache = new SyntheticLegCache<number>(2);
        const make = (key: string): Promise<number> => {
            const p = Promise.resolve(1);
            cache.set(key, p);
            return p;
        };
        const get = (key: string): Promise<number> => cache.get(key) ?? make(key);

        await get("a");           // [a]
        await get("b");           // [a, b]
        await get("a");           // touch a -> [b, a]
        await get("c");           // evict b (LRU) -> [a, c]

        expect(cache.size).to.equal(2);
        expect(cache.get("b"), "b was LRU and must be evicted").to.equal(undefined);
        expect(cache.get("a"), "a was touched and must remain").to.not.equal(undefined);
    });

    it("evicts a failed promise so the next request retries", async () => {
        const cache = new SyntheticLegCache<number>(4);
        let producerCalls = 0;

        const first = new Promise<number>((_, reject) => {
            producerCalls += 1;
            setTimeout(() => reject(new Error("network")), 5);
        });
        cache.set("flaky", first);
        await first.catch(() => {});

        // After rejection, the entry must be gone so a retry is possible.
        expect(cache.get("flaky"), "failed promise must be evicted").to.equal(undefined);

        const second = new Promise<number>((resolve) => {
            producerCalls += 1;
            setTimeout(() => resolve(42), 5);
        });
        cache.set("flaky", second);
        expect(await second).to.equal(42);
        expect(producerCalls, "retry must invoke the producer again").to.equal(2);
    });

    it("can delete a single cached promise without clearing the whole LRU", async () => {
        const cache = new SyntheticLegCache<number>(4);
        cache.set("aborted", Promise.resolve(1));
        cache.set("healthy", Promise.resolve(2));

        cache.delete("aborted");

        expect(cache.get("aborted"), "aborted entry must be removed").to.equal(undefined);
        expect(await cache.get("healthy")).to.equal(2);
        expect(cache.size).to.equal(1);
    });

    it("does not delete a newer promise when evicting an older one by identity", async () => {
        const cache = new SyntheticLegCache<number>(4);
        const oldPromise = Promise.resolve(1);
        const newPromise = Promise.resolve(2);
        cache.set("same-key", oldPromise);
        cache.set("same-key", newPromise);

        cache.deleteIfValue("same-key", oldPromise);

        expect(await cache.get("same-key")).to.equal(2);
    });
});

describe("synthetic cache keys", () => {
    it("leg key is symbol|interval|bars with normalized case", () => {
        expect(buildLegCacheKey("zecusdt", "1M", 50000)).to.equal("ZECUSDT|1m|50000");
    });

    it("pair key includes synthetic symbol, both legs, interval, source interval, bars", () => {
        const key = buildPairCacheKey({
            syntheticSymbol: "zecapt",
            baseSymbol: "zecusdt",
            quoteSymbol: "aptusdt",
            interval: "1H",
            sourceInterval: "5M",
            sourceBars: 50000,
        });
        expect(key).to.equal("ZECAPT|ZECUSDT|APTUSDT|1h|5m|50000|synthetic");
    });
});
