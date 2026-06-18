import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import { DataCache } from "../lib/data/data-cache";
import { DataFetcher, type DataLoadReporter } from "../lib/data/data-fetcher";
import {
    isBybitTradFiSymbolKnownUnsupported,
    resetBybitTradFiSymbolSupportForTests,
} from "../lib/dataProviders/bybit";
import { resetLocalApiAvailability } from "../lib/local-api-transport";
import type { OHLCVData } from "../lib/types/strategies";

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
    resetBybitTradFiSymbolSupportForTests();
    resetLocalApiAvailability();
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
    persistence?: any;
    reporter?: DataLoadReporter;
}): DataFetcher {
    const providerRouter = {
        getProvider: () => options.provider ?? "binance",
        getStorageSymbol: (symbol: string) => symbol,
        getProviderStorageLabel: () => "Binance Spot",
    };

    return new DataFetcher(
        providerRouter as any,
        options.cache ?? new DataCache(),
        options.persistence ?? {} as any,
        () => options.importedDataByKey ?? new Map<string, OHLCVData[]>(),
        options.getLookbackBars,
        options.reporter ?? {}
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

    it("keeps local daily seed data when Bybit rejects every symbol alias", async () => {
        const candles = makeCandles(500);
        let requestCount = 0;
        let sourceLabel = "";
        let sourceTone = "";

        globalThis.fetch = async () => {
            requestCount += 1;
            return new Response(JSON.stringify({
                ret_code: 10001,
                ret_msg: "invalid symbol",
                result: { list: [] },
            }), { status: 200, headers: { "content-type": "application/json" } });
        };

        const fetcher = new DataFetcher(
            {
                getProvider: () => "bybit-tradfi",
                getStorageSymbol: (symbol: string) => symbol,
                getProviderStorageLabel: () => "Bybit TradFi",
            } as any,
            new DataCache(),
            {
                loadNonBinanceLocalData: async () => ({ candles, source: "seed" }),
            } as any,
            () => new Map<string, OHLCVData[]>(),
            () => null,
            {
                updateSymbolDataSource: (label, tone) => {
                    sourceLabel = label;
                    sourceTone = tone;
                },
            }
        );

        const data = await fetcher.fetchData("NOPESTOCK", "1d");

        assert.deepEqual(data, candles);
        assert.equal(sourceLabel, "Local seed");
        assert.equal(sourceTone, "seed");
        assert.equal(isBybitTradFiSymbolKnownUnsupported("NOPESTOCK"), true);
        assert.equal(requestCount > 0, true);
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

    it("dedupes concurrent supported 1s chart loads", async () => {
        let requestCount = 0;
        globalThis.fetch = async () => {
            requestCount += 1;
            await new Promise((resolve) => setTimeout(resolve, 10));
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

        const [left, right] = await Promise.all([
            fetcher.fetchData("BTCUSDT", "1s"),
            fetcher.fetchData("BTCUSDT", "1s"),
        ]);

        assert.equal(requestCount, 1);
        assert.deepEqual(left, right);
        assert.deepEqual(left.map((candle) => candle.time), [1_700_000_001, 1_700_000_002]);
    });

    it("keeps detached chart loads out of the shared in-flight UI load", async () => {
        let requestCount = 0;
        let reportCount = 0;
        globalThis.fetch = async () => {
            requestCount += 1;
            await new Promise((resolve) => setTimeout(resolve, 10));
            return new Response(JSON.stringify({
                ok: true,
                candles: [
                    { ts: 1_700_000_001, open: 100, high: 101, low: 99, close: 100.5, volume: 10 },
                ],
            }), { status: 200 });
        };

        const fetcher = createFetcher({
            getLookbackBars: () => 1,
            reporter: {
                updateSymbolDataSource: () => {
                    reportCount += 1;
                },
            },
        });

        await Promise.all([
            fetcher.fetchDataDetached("BTCUSDT", "1s"),
            fetcher.fetchData("BTCUSDT", "1s"),
        ]);

        assert.equal(requestCount, 2);
        assert.equal(reportCount, 1);
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

    it("backfills Binance historical limit requests before a short cached window", async () => {
        resetLocalApiAvailability();
        const cachedCandles = Array.from({ length: 8 }, (_, index) => {
            const time = (index + 3) * 300;
            return {
                time,
                open: 100 + index,
                high: 101 + index,
                low: 99 + index,
                close: 100.5 + index,
                volume: 1000 + index,
            };
        });
        const requestedUrls: URL[] = [];

        const toBinanceKline = (timeSec: number, price: number) => ([
            timeSec * 1000,
            String(price),
            String(price + 1),
            String(price - 1),
            String(price + 0.5),
            "1000",
        ]);

        globalThis.fetch = async (input) => {
            const url = new URL(String(input), "http://localhost");
            requestedUrls.push(url);

            if (url.pathname === "/api/sqlite/status") {
                return new Response("ok", { status: 200 });
            }
            if (url.pathname === "/api/sqlite/load-ohlcv") {
                assert.equal(url.searchParams.get("limit"), "10");
                return new Response(JSON.stringify({ ok: true, candles: cachedCandles }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }
            if (url.pathname === "/api/v3/klines") {
                assert.equal(url.searchParams.get("startTime"), null);
                assert.equal(url.searchParams.get("endTime"), "899999");
                assert.equal(url.searchParams.get("limit"), "2");
                return new Response(JSON.stringify([
                    toBinanceKline(300, 98),
                    toBinanceKline(600, 99),
                ]), { status: 200 });
            }
            if (url.pathname === "/api/sqlite/store-ohlcv") {
                return new Response(JSON.stringify({ ok: true, upserted: 2, totalBars: 10 }), { status: 200 });
            }

            throw new Error(`Unexpected request: ${url.toString()}`);
        };

        const fetcher = createFetcher({
            getLookbackBars: () => null,
            persistence: {
                persistLocalCandles: async () => undefined,
            },
        });

        const data = await fetcher.fetchDataWithLimit("ETHUSDT", "5m", 10, { requestDelayMs: 0 });
        const binanceRequests = requestedUrls.filter((url) => url.hostname === "api.binance.com");

        assert.equal(binanceRequests.length, 1);
        assert.equal(data.length, 10);
        assert.deepEqual(data.map((candle) => candle.time), [300, 600, 900, 1_200, 1_500, 1_800, 2_100, 2_400, 2_700, 3_000]);
    });

    it("offline detached load serves SQLite cache without any Binance gap-fill", async () => {
        resetLocalApiAvailability();
        const cachedCandles = Array.from({ length: 12 }, (_, index) => {
            const time = (index + 1) * 300;
            return {
                time,
                open: 100 + index,
                high: 101 + index,
                low: 99 + index,
                close: 100.5 + index,
                volume: 1000 + index,
            };
        });
        const requestedPaths: string[] = [];

        globalThis.fetch = async (input) => {
            const url = new URL(String(input), "http://localhost");
            requestedPaths.push(url.pathname);

            if (url.pathname === "/api/sqlite/status") {
                return new Response("ok", { status: 200 });
            }
            if (url.pathname === "/api/sqlite/load-ohlcv") {
                return new Response(JSON.stringify({ ok: true, candles: cachedCandles }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }
            if (url.pathname === "/api/sqlite/store-ohlcv") {
                return new Response(JSON.stringify({ ok: true, upserted: 0, totalBars: cachedCandles.length }), { status: 200 });
            }
            // Any Binance hit is a regression: offline Universe loads must skip the remote gap-fill.
            throw new Error(`Unexpected remote request: ${url.toString()}`);
        };

        const fetcher = createFetcher({
            getLookbackBars: () => null,
            persistence: {
                persistLocalCandles: async () => undefined,
            },
        });

        const data = await fetcher.fetchDataDetached("ETHUSDT", "5m", { offline: true });
        const binanceRequests = requestedPaths.filter((path) => path === "/api/v3/klines" || path === "/api/fapi/v1/klines");

        assert.equal(binanceRequests.length, 0, "offline mode must not hit Binance when local data exists");
        assert.equal(data.length, cachedCandles.length);
        assert.deepEqual(
            data.map((candle) => candle.time),
            cachedCandles.map((candle) => candle.time),
        );
    });

    it("offline detached load on a fully cold symbol still falls back to remote (cold-symbol safety net)", async () => {
        resetLocalApiAvailability();
        const toBinanceKline = (timeSec: number, price: number) => ([
            timeSec * 1000,
            String(price),
            String(price + 1),
            String(price - 1),
            String(price + 0.5),
            "1000",
        ]);
        let binanceHits = 0;

        globalThis.fetch = async (input) => {
            const url = new URL(String(input), "http://localhost");

            if (url.pathname === "/api/sqlite/status") {
                return new Response("ok", { status: 200 });
            }
            if (url.pathname === "/api/sqlite/load-ohlcv") {
                return new Response(JSON.stringify({ ok: true, candles: [] }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }
            if (url.pathname === "/api/sqlite/store-ohlcv") {
                return new Response(JSON.stringify({ ok: true, upserted: 0, totalBars: 0 }), { status: 200 });
            }
            if (url.pathname === "/api/v3/klines") {
                binanceHits += 1;
                return new Response(JSON.stringify([
                    toBinanceKline(300, 99),
                    toBinanceKline(600, 100),
                ]), { status: 200 });
            }

            throw new Error(`Unexpected request: ${url.toString()}`);
        };

        const fetcher = createFetcher({
            getLookbackBars: () => null,
            persistence: {
                persistLocalCandles: async () => undefined,
            },
        });

        const data = await fetcher.fetchDataDetached("ETHUSDT", "5m", { offline: true });

        assert.ok(binanceHits >= 1, "cold symbol with no local data must still go remote for correctness");
        assert.ok(data.length >= 1);
    });

    it("non-offline detached load still performs the Binance gap-fill on warm cache", async () => {
        resetLocalApiAvailability();
        const cachedCandles = Array.from({ length: 12 }, (_, index) => {
            const time = (index + 1) * 300;
            return {
                time,
                open: 100 + index,
                high: 101 + index,
                low: 99 + index,
                close: 100.5 + index,
                volume: 1000 + index,
            };
        });
        const toBinanceKline = (timeSec: number, price: number) => ([
            timeSec * 1000,
            String(price),
            String(price + 1),
            String(price - 1),
            String(price + 0.5),
            "1000",
        ]);
        let binanceHits = 0;

        globalThis.fetch = async (input) => {
            const url = new URL(String(input), "http://localhost");

            if (url.pathname === "/api/sqlite/status") {
                return new Response("ok", { status: 200 });
            }
            if (url.pathname === "/api/sqlite/load-ohlcv") {
                return new Response(JSON.stringify({ ok: true, candles: cachedCandles }), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }
            if (url.pathname === "/api/sqlite/store-ohlcv") {
                return new Response(JSON.stringify({ ok: true, upserted: 0, totalBars: cachedCandles.length }), { status: 200 });
            }
            if (url.pathname === "/api/v3/klines") {
                binanceHits += 1;
                return new Response(JSON.stringify([]), { status: 200 });
            }

            throw new Error(`Unexpected request: ${url.toString()}`);
        };

        const fetcher = createFetcher({
            getLookbackBars: () => null,
            persistence: {
                persistLocalCandles: async () => undefined,
            },
        });

        const data = await fetcher.fetchDataDetached("ETHUSDT", "5m");

        assert.ok(binanceHits >= 1, "non-offline detached path must still perform the remote gap-fill");
        assert.equal(data.length, cachedCandles.length);
    });
});
