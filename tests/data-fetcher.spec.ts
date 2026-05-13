import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { DataCache } from "../lib/data/data-cache";
import { DataFetcher } from "../lib/data/data-fetcher";
import type { OHLCVData } from "../lib/types/strategies";

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
});

function makeCandles(count: number): OHLCVData[] {
    return Array.from({ length: count }, (_, index) => {
        const base = index + 1;
        return {
            time: base * 60,
            open: base,
            high: base + 1,
            low: Math.max(0.1, base - 0.5),
            close: base + 0.5,
            volume: 1000 + index,
        };
    });
}

function createFetcher(options: {
    cache?: DataCache;
    importedDataByKey?: Map<string, OHLCVData[]>;
    getLookbackBars: () => number | null;
    provider?: string;
}): DataFetcher {
    const providerRouter = {
        getProvider: () => options.provider ?? "binance",
        getStorageSymbol: (symbol: string) => symbol,
        getProviderStorageLabel: () => "Binance Spot",
    };

    return new DataFetcher(
        providerRouter as any,
        options.cache ?? new DataCache(),
        {} as any,
        () => options.importedDataByKey ?? new Map<string, OHLCVData[]>(),
        options.getLookbackBars,
        {}
    );
}

describe("DataFetcher chart lookback", () => {
    it("applies the current lookback to cached chart data", async () => {
        const cache = new DataCache();
        const candles = makeCandles(26_000);
        cache.set("ETHUSDT::1m", candles, "network");

        let lookbackBars = 300;
        const fetcher = createFetcher({
            cache,
            getLookbackBars: () => lookbackBars,
        });

        const trimmed = await fetcher.fetchData("ETHUSDT", "1m");
        assert.equal(trimmed.length, 300);
        assert.deepEqual(trimmed, candles.slice(-300));

        lookbackBars = 1_000;
        const expanded = await fetcher.fetchData("ETHUSDT", "1m");
        assert.equal(expanded.length, 1_000);
        assert.deepEqual(expanded, candles.slice(-1_000));
    });

    it("applies the current lookback to imported chart data", async () => {
        const candles = makeCandles(1_200);
        const importedDataByKey = new Map<string, OHLCVData[]>([
            ["ETHUSDT::1m", candles],
        ]);

        const fetcher = createFetcher({
            importedDataByKey,
            getLookbackBars: () => 300,
        });

        const trimmed = await fetcher.fetchData("ETHUSDT", "1m");
        assert.equal(trimmed.length, 300);
        assert.deepEqual(trimmed, candles.slice(-300));
    });

    it("loads supported 1s charts from the second-market SQLite endpoint", async () => {
        let requestedUrl = "";
        globalThis.fetch = async (input) => {
            requestedUrl = String(input);
            return new Response(JSON.stringify({
                ok: true,
                candles: [
                    { ts: 1_700_000_001, open: 100, high: 101, low: 99, close: 100.5, volume: 10 },
                    { ts: 1_700_000_002, open: 100.5, high: 102, low: 100, close: 101, volume: 12 },
                ],
            }), { status: 200 });
        };

        const fetcher = createFetcher({
            getLookbackBars: () => 2,
        });

        const data = await fetcher.fetchData("BTCUSDT", "1s");
        const url = new URL(requestedUrl);

        assert.equal(url.pathname, "/api/second-market/candles");
        assert.equal(url.searchParams.get("symbol"), "BTCUSDT");
        assert.equal(url.searchParams.get("limit"), "2");
        assert.equal(url.searchParams.get("marketType"), "spot");
        assert.deepEqual(data.map((candle) => candle.time), [1_700_000_001, 1_700_000_002]);
    });

    it("loads 1s charts with the selected Binance futures market type", async () => {
        let requestedUrl = "";
        globalThis.fetch = async (input) => {
            requestedUrl = String(input);
            return new Response(JSON.stringify({
                ok: true,
                candles: [
                    { ts: 1_700_000_001, open: 100, high: 101, low: 99, close: 100.5, volume: 10 },
                ],
            }), { status: 200 });
        };

        const fetcher = createFetcher({
            getLookbackBars: () => 1,
            provider: "binance-futures",
        });

        await fetcher.fetchData("BTCUSDT", "1s");
        const url = new URL(requestedUrl);

        assert.equal(url.searchParams.get("marketType"), "futures");
    });

    it("sanitizes unaligned Binance candles from the in-memory cache", async () => {
        const cache = new DataCache();
        const candles: OHLCVData[] = [
            { time: 0, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: 1_800, open: 101, high: 102, low: 100, close: 101, volume: 1000 },
            { time: 3_600, open: 102, high: 103, low: 101, close: 102, volume: 1000 },
            { time: 5_400, open: 103, high: 104, low: 102, close: 103, volume: 1000 },
            { time: 7_200, open: 104, high: 105, low: 103, close: 104, volume: 1000 },
        ];
        cache.set("ETHUSDT::1h", candles, "network");

        const fetcher = createFetcher({
            cache,
            getLookbackBars: () => null,
        });

        const data = await fetcher.fetchData("ETHUSDT", "1h");
        assert.deepEqual(data.map((candle) => candle.time), [0, 3_600, 7_200]);
    });
});
