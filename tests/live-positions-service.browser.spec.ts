/**
 * Live-price quote deadline and identity regressions.
 *
 * `fetchCurrentPrice` is driven through a narrow test seam so the specs can
 * exercise the transport, pending-request, and cache-identity behavior without
 * running the full subscription poll. Mock timers drive the 5s per-attempt
 * ticker deadlines so no test waits on real time.
 *
 * Phase coverage:
 * - deadlines stay active while a ticker JSON body is consumed (a stalled body
 *   settles through the per-attempt deadline instead of pinning
 *   PRICE_REQUESTS forever);
 * - Stop/caller cancellation after headers still works;
 * - the pending entry is released after failure so a subsequent request can
 *   start;
 * - provider-scoped identity: spot and futures requests for one symbol never
 *   share a cached or in-flight quote, Binance ticker keys stay
 *   interval-independent, and the Bybit TradFi key includes the normalized
 *   fallback interval because the fallback candle price depends on it;
 * - the active-chart shortcut only reuses candles whose loaded context
 *   (symbol + interval + Binance market) provably matches the requested
 *   provider.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { livePositionsService, type LivePosition } from "../lib/live-positions-service";
import { state } from "../lib/state";
import { dataManager } from "../lib/data-manager";
import { commitOhlcvData } from "../lib/state-actions";
import { uiManager } from "../lib/ui-manager";
import type { DataProvider } from "../lib/types/data-providers";
import type { BacktestSettings, OHLCVData, Time } from "../lib/types/strategies";

const originalFetch = globalThis.fetch;

const tickerResponse = (price: string): Response => new Response(
    JSON.stringify({ symbol: "BTCUSDT", price }),
    { status: 200, headers: { "content-type": "application/json" } },
);

const stalledBodyResponse = (init: RequestInit | undefined): Response => {
    const signal = init!.signal!;
    return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
            signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
    }));
};

const drain = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/** Advance mock timers until `op` settles; each tick clears every due deadline/backoff. */
async function tickUntilSettled(t: { mock: { timers: { tick: (ms: number) => void } } }, op: Promise<unknown>, maxTicks = 400): Promise<void> {
    let settled = false;
    op.then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < maxTicks && !settled; i += 1) {
        await drain();
        t.mock.timers.tick(6_000);
    }
    await drain();
}

const fetchQuote = (symbol: string, provider: DataProvider, interval = "4h"): Promise<number | null> =>
    livePositionsService.__fetchCurrentPriceForTests(symbol, interval, provider);

describe("live price ticker deadlines", () => {
    beforeEach(() => {
        livePositionsService.__resetLivePriceCachesForTests();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        livePositionsService.__resetLivePriceCachesForTests();
    });

    it("consumes a normal Binance ticker response inside the deadline scope", async () => {
        let calls = 0;
        globalThis.fetch = (async () => {
            calls += 1;
            return tickerResponse("65000.5");
        }) as typeof fetch;

        const price = await fetchQuote("BTCUSDT", "binance");

        assert.equal(price, 65000.5);
        assert.equal(calls, 1);
    });

    it("aborts a stalled ticker body at the per-attempt deadline and recovers on retry", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        let calls = 0;
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            calls += 1;
            if (calls === 1) return stalledBodyResponse(init);
            return tickerResponse("65001");
        }) as typeof fetch;

        const op = fetchQuote("BTCUSDT", "binance");
        await tickUntilSettled(t, op);

        assert.equal(await op, 65001);
        assert.equal(calls, 2);
    });

    it("releases the pending quote after exhausted deadlines so a later request can start", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => stalledBodyResponse(init)) as typeof fetch;

        // Every attempt (2 Binance + 2 Bybit fallback) stalls until its 5s
        // deadline; the quote then fails instead of pinning PRICE_REQUESTS.
        const failed = fetchQuote("BTCUSDT", "binance");
        await tickUntilSettled(t, failed);
        assert.equal(await failed, null);

        // A subsequent request runs its own transport instead of joining the
        // wedged one that used to hang forever.
        globalThis.fetch = (async () => tickerResponse("65002")) as typeof fetch;
        assert.equal(await fetchQuote("BTCUSDT", "binance"), 65002);
    });

    it("treats a malformed JSON body as a failed attempt and recovers on retry", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        let calls = 0;
        globalThis.fetch = (async () => {
            calls += 1;
            return calls === 1
                ? new Response("{not json", { status: 200, headers: { "content-type": "application/json" } })
                : tickerResponse("65003");
        }) as typeof fetch;

        const op = fetchQuote("BTCUSDT", "binance");
        await tickUntilSettled(t, op);

        assert.equal(await op, 65003);
        assert.equal(calls, 2);
    });

    it("keeps the Bybit linear fallback working when Binance fails its attempts", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const calls: string[] = [];
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = String(input);
            calls.push(url.includes("binance") ? "binance" : "bybit");
            if (url.includes("binance")) {
                return new Response("rate limited", { status: 503 });
            }
            return new Response(JSON.stringify({
                result: { list: [{ lastPrice: "65004.25" }] },
            }), { status: 200, headers: { "content-type": "application/json" } });
        }) as typeof fetch;

        const op = fetchQuote("BTCUSDT", "binance");
        await tickUntilSettled(t, op);

        assert.equal(await op, 65004.25);
        // Binance exhausted its 2 attempts, then the Bybit fallback answered.
        assert.deepEqual(calls.filter((host) => host === "binance"), ["binance", "binance"]);
        assert.deepEqual(calls.filter((host) => host === "bybit"), ["bybit"]);
    });
});

describe("live price provider identity", () => {
    beforeEach(() => {
        livePositionsService.__resetLivePriceCachesForTests();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        livePositionsService.__resetLivePriceCachesForTests();
    });

    it("never shares a quote between spot and futures requests for one symbol", async () => {
        const urls: string[] = [];
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = String(input);
            urls.push(url);
            return tickerResponse(url.includes("fapi") ? "65200" : "65100");
        }) as typeof fetch;

        const [spot, futures] = await Promise.all([
            fetchQuote("BTCUSDT", "binance"),
            fetchQuote("BTCUSDT", "binance-futures"),
        ]);

        assert.equal(spot, 65100);
        assert.equal(futures, 65200);
        // Each subscription drove its own transport instead of joining the
        // other market's in-flight quote.
        assert.equal(urls.length, 2);
    });

    it("deduplicates concurrent requests for the same provider and symbol", async () => {
        let calls = 0;
        globalThis.fetch = (async () => {
            calls += 1;
            return tickerResponse("65101");
        }) as typeof fetch;

        const [first, second] = await Promise.all([
            fetchQuote("BTCUSDT", "binance"),
            fetchQuote("BTCUSDT", "binance"),
        ]);

        assert.equal(first, 65101);
        assert.equal(second, 65101);
        assert.equal(calls, 1);
    });

    it("serves TTL-fresh repeat quotes from the cache and refetches after expiry", async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
        let calls = 0;
        globalThis.fetch = (async () => {
            calls += 1;
            return tickerResponse(calls === 1 ? "65102" : "65103");
        }) as typeof fetch;

        assert.equal(await fetchQuote("BTCUSDT", "binance"), 65102);
        assert.equal(await fetchQuote("BTCUSDT", "binance"), 65102);
        assert.equal(calls, 1);

        // Half the 30s poll interval: the TTL is 15s.
        t.mock.timers.tick(15_001);
        assert.equal(await fetchQuote("BTCUSDT", "binance"), 65103);
        assert.equal(calls, 2);
    });

    it("scopes the Bybit TradFi quote by its normalized fallback interval", async () => {
        const intervals: string[] = [];
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = String(input);
            if (!url.includes("tradfi-kline")) return new Response("{}", { status: 404 });
            const interval = new URL(url, "https://local.test").searchParams.get("interval") ?? "";
            intervals.push(interval);
            const list = interval === "1"
                ? [] // the 1m probe returns nothing, so the interval fallback decides
                : [[1700000000000, "99", "101", "98", interval === "D+2" ? "100" : "55", "0"]];
            return new Response(JSON.stringify({ retCode: 0, result: { list } }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }) as typeof fetch;

        const [daily, fourHour] = await Promise.all([
            fetchQuote("AAPL", "bybit-tradfi", "1d"),
            fetchQuote("AAPL", "bybit-tradfi", "4h"),
        ]);

        assert.equal(daily, 100);
        assert.equal(fourHour, 55);
        // Both interval quotes ran their own fallback fetch ('1' probes plus
        // one D+2 / one 60 request) instead of sharing one cached candle price.
        assert.deepEqual(intervals.filter((value) => value === "D+2"), ["D+2"]);
        assert.deepEqual(intervals.filter((value) => value === "60"), ["60"]);
    });
});

describe("live price active-chart shortcut eligibility", () => {
    const chartCandles: OHLCVData[] = [
        { time: 1700000000 as Time, open: 100, high: 110, low: 95, close: 105, volume: 1 },
        { time: 1700003600 as Time, open: 105, high: 115, low: 100, close: 108, volume: 1 },
    ];

    const installTickerCounter = (): { calls: () => number } => {
        let calls = 0;
        globalThis.fetch = (async () => {
            calls += 1;
            return tickerResponse("65200");
        }) as typeof fetch;
        return { calls: () => calls };
    };

    beforeEach(() => {
        livePositionsService.__resetLivePriceCachesForTests();
        state.currentSymbol = "BTCUSDT";
        state.currentInterval = "4h";
        state.binanceMarketType = "spot";
        state.ohlcvData = chartCandles;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        livePositionsService.__resetLivePriceCachesForTests();
        state.currentSymbol = "ETHUSDT";
        state.currentInterval = "1d";
        state.binanceMarketType = "spot";
        state.ohlcvData = [];
        dataManager.__setLoadedContextForTests(null, null);
    });

    it("reuses the loaded chart close without a request when the loaded context matches", async () => {
        dataManager.__setLoadedContextForTests("BTCUSDT", "4h", "spot");
        const transport = installTickerCounter();

        const price = await fetchQuote("BTCUSDT", "binance", "4h");

        assert.equal(price, 108);
        assert.equal(transport.calls(), 0);
    });

    it("skips the shortcut when the loaded market differs from the requested provider", async () => {
        // Spot data is loaded, but the subscription quotes Binance futures —
        // the same selection-change window the shortcut used to get wrong.
        dataManager.__setLoadedContextForTests("BTCUSDT", "4h", "spot");
        const transport = installTickerCounter();

        const price = await fetchQuote("BTCUSDT", "binance-futures", "4h");

        assert.equal(price, 65200);
        assert.equal(transport.calls(), 1);
    });

    it("skips the shortcut when no dataset finished loading (imported data)", async () => {
        dataManager.__setLoadedContextForTests(null, null);
        const transport = installTickerCounter();

        const price = await fetchQuote("BTCUSDT", "binance", "4h");

        assert.equal(price, 65200);
        assert.equal(transport.calls(), 1);
    });

    it("skips the shortcut for a symbol mismatch or a non-Binance provider", async () => {
        dataManager.__setLoadedContextForTests("BTCUSDT", "4h", "spot");
        // Serve the TradFi '1m' probe directly so each non-Binance quote is a
        // single fetch.
        let calls = 0;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            calls += 1;
            const url = String(input);
            if (url.includes("tradfi-kline")) {
                return new Response(JSON.stringify({
                    retCode: 0,
                    result: { list: [[1700000000000, "65000", "65201", "64999", "65200", "0"]] },
                }), { status: 200, headers: { "content-type": "application/json" } });
            }
            return tickerResponse("65200");
        }) as typeof fetch;

        // Loaded BTCUSDT but the subscription asks for ETHUSDT.
        assert.equal(await fetchQuote("ETHUSDT", "binance", "4h"), 65200);
        // TradFi candles have no tracked provenance, so no shortcut even with
        // a matching symbol/interval context.
        assert.equal(await fetchQuote("BTCUSDT", "bybit-tradfi", "4h"), 65200);
        assert.equal(calls, 2);
    });
});

describe("live price chart provenance lifecycle", () => {
    const btcCandles: OHLCVData[] = [
        { time: 1700000000 as Time, open: 100, high: 110, low: 95, close: 105, volume: 1 },
        { time: 1700003600 as Time, open: 105, high: 115, low: 100, close: 108, volume: 1 },
    ];
    const drain = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

    const installTickerCounter = (price: string): { calls: () => number } => {
        let calls = 0;
        globalThis.fetch = (async () => {
            calls += 1;
            return tickerResponse(price);
        }) as typeof fetch;
        return { calls: () => calls };
    };

    const position = (overrides: Partial<LivePosition>): LivePosition => ({
        streamId: "stream",
        symbol: "BTCUSDT",
        interval: "4h",
        strategyKey: "strategy",
        strategyParams: {},
        backtestSettings: { executionModel: "signal_close" } as BacktestSettings,
        configName: null,
        direction: "long",
        entryPrice: 100,
        entryTime: 1700000000,
        currentPrice: null,
        unrealizedPnl: null,
        unrealizedPnlPercent: null,
        stopLossPrice: null,
        takeProfitPrice: null,
        isOpen: true,
        lastSignalFromWorker: null,
        localBacktestTrade: null,
        mismatch: false,
        mismatchReason: null,
        lastUpdated: 0,
        ...overrides,
    });

    beforeEach(() => {
        livePositionsService.__resetLivePriceCachesForTests();
        state.currentSymbol = "BTCUSDT";
        state.currentInterval = "4h";
        state.binanceMarketType = "spot";
        state.ohlcvData = btcCandles.map((bar) => ({ ...bar }));
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        livePositionsService.__resetLivePriceCachesForTests();
        livePositionsService.__setOpenPositionsForTests([]);
        state.currentSymbol = "ETHUSDT";
        state.currentInterval = "1d";
        state.binanceMarketType = "spot";
        state.ohlcvData = [];
        dataManager.__setLoadedContextForTests(null, null);
    });

    it("revalidates selection and candles after resolving provenance dependencies", async () => {
        dataManager.__setLoadedContextForTests("BTCUSDT", "4h", "spot");
        const transport = installTickerCounter("65300");

        const pending = fetchQuote("BTCUSDT", "binance", "4h");
        // Runs inside the quote's dependency-resolution window, before the
        // eligibility re-check: the selection and the chart dataset change.
        state.currentSymbol = "ETHUSDT";
        state.ohlcvData = [{ time: 1700007200 as Time, open: 2900, high: 3100, low: 2800, close: 3000, volume: 1 }];

        assert.equal(await pending, 65300);
        assert.equal(transport.calls(), 1);
    });

    it("donates while provenance holds and fetches after an import replaces the dataset", async () => {
        dataManager.__setLoadedContextForTests("BTCUSDT", "4h", "spot");
        const transport = installTickerCounter("65400");

        // The network dataset is provably loaded: its close is donated.
        assert.equal(await fetchQuote("BTCUSDT", "binance", "4h"), 108);
        assert.equal(transport.calls(), 0);

        // The normal import lifecycle: publish a new array, then register it.
        const imported: OHLCVData[] = [
            { time: 1700007200 as Time, open: 120, high: 125, low: 118, close: 123, volume: 1 },
        ];
        commitOhlcvData(imported, "data_mining_import");
        dataManager.registerImportedData("BTCUSDT", "4h", imported);

        assert.equal(await fetchQuote("BTCUSDT", "binance", "4h"), 65400);
        assert.equal(transport.calls(), 1);
    });

    it("keeps provenance across in-place realtime stream growth", async () => {
        dataManager.__setLoadedContextForTests("BTCUSDT", "4h", "spot");
        const transport = installTickerCounter("65500");

        // The stream mutates the shared array in place: same reference, new bar.
        state.ohlcvData.push({ time: 1700007200 as Time, open: 106, high: 116, low: 102, close: 109, volume: 1 });

        assert.equal(await fetchQuote("BTCUSDT", "binance", "4h"), 109);
        assert.equal(transport.calls(), 0);
    });

    it("syncActiveChartPrice updates only positions whose market matches the loaded chart", async () => {
        await drain(); // resolve the service's data-manager dependency
        dataManager.__setLoadedContextForTests("BTCUSDT", "4h", "spot");
        const futures = position({
            currentPrice: 200,
            unrealizedPnl: 100,
            unrealizedPnlPercent: 100,
            backtestSettings: { executionModel: "signal_close", binanceMarketType: "futures" } as BacktestSettings,
        });
        const spot = position({
            currentPrice: null,
            unrealizedPnl: null,
            unrealizedPnlPercent: null,
        });
        livePositionsService.__setOpenPositionsForTests([futures, spot]);

        livePositionsService.syncActiveChartPrice();

        const positions = livePositionsService.getState().positions;
        // The spot chart must not reprice the futures position...
        assert.equal(positions[0]!.currentPrice, 200);
        assert.equal(positions[0]!.unrealizedPnl, 100);
        // ...but the compatible spot position accepts the close (PnL math intact).
        assert.equal(positions[1]!.currentPrice, 108);
        assert.equal(positions[1]!.unrealizedPnl, 8);
    });

    it("syncActiveChartPrice donates to a futures position only under a futures-loaded chart", async () => {
        await drain();
        dataManager.__setLoadedContextForTests("BTCUSDT", "4h", "futures");
        const futures = position({
            currentPrice: null,
            unrealizedPnl: null,
            unrealizedPnlPercent: null,
            backtestSettings: { executionModel: "signal_close", binanceMarketType: "futures" } as BacktestSettings,
        });
        const spot = position({
            currentPrice: 200,
            unrealizedPnl: 100,
            unrealizedPnlPercent: 100,
        });
        livePositionsService.__setOpenPositionsForTests([futures, spot]);

        livePositionsService.syncActiveChartPrice();

        const positions = livePositionsService.getState().positions;
        assert.equal(positions[0]!.currentPrice, 108);
        assert.equal(positions[0]!.unrealizedPnl, 8);
        assert.equal(positions[1]!.currentPrice, 200);
        assert.equal(positions[1]!.unrealizedPnl, 100);
    });

    it("syncActiveChartPrice donates nothing when chart provenance is unknown", async () => {
        await drain();
        // Imported/synthetic data has no loaded context.
        dataManager.__setLoadedContextForTests(null, null);
        const futures = position({ currentPrice: 200, unrealizedPnl: 100, unrealizedPnlPercent: 100 });
        const spot = position({ currentPrice: 200, unrealizedPnl: 100, unrealizedPnlPercent: 100 });
        livePositionsService.__setOpenPositionsForTests([futures, spot]);

        livePositionsService.syncActiveChartPrice();

        const positions = livePositionsService.getState().positions;
        assert.equal(positions[0]!.currentPrice, 200);
        assert.equal(positions[1]!.currentPrice, 200);
    });
});

describe("stream publication provenance", () => {
    const drain = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

    const position = (overrides: Partial<LivePosition>): LivePosition => ({
        streamId: "stream",
        symbol: "BTCUSDT",
        interval: "4h",
        strategyKey: "strategy",
        strategyParams: {},
        backtestSettings: { executionModel: "signal_close" } as BacktestSettings,
        configName: null,
        direction: "long",
        entryPrice: 100,
        entryTime: 1700000000,
        currentPrice: null,
        unrealizedPnl: null,
        unrealizedPnlPercent: null,
        stopLossPrice: null,
        takeProfitPrice: null,
        isOpen: true,
        lastSignalFromWorker: null,
        localBacktestTrade: null,
        mismatch: false,
        mismatchReason: null,
        lastUpdated: 0,
        ...overrides,
    });
    const FIRST_CANDLE_TIME = 1700006400; // 4h-aligned
    const CHART_TIMES = [1700006400, 1700020800]; // two consecutive 4h bars
    const GAP_TIMES = [1700035200, 1700049600]; // the two bars the gap fill fetches
    const INCOMING_TIME = 1700064000; // one skipped bar pair after the chart tail

    const candle = (time: number, close: number): OHLCVData => ({
        time: time as Time, open: close - 1, high: close + 1, low: close - 2, close, volume: 1,
    });
    const klineRow = (time: number, close: number): unknown[] =>
        [time * 1000, String(close - 1), String(close + 1), String(close - 2), String(close), "1"];

    type Internals = {
        handleStreamUpdate: (candle: OHLCVData, sessionId?: number, symbol?: string, interval?: string, provider?: string) => void;
        backfillRealtimeGap: (sessionId: number, symbol: string, interval: string, provider: string, latestTime: unknown) => Promise<void>;
        fetcher: { queuePersistCandles: () => void };
    };
    const internals = (): Internals => dataManager as unknown as Internals;

    let observations: Array<{ contextKey: string | null; spotPrice: number | null; futuresPrice: number | null }>;
    let unsubscribe: (() => void) | null = null;

    const installObserver = (): void => {
        observations = [];
        unsubscribe = state.subscribe("ohlcvData", () => {
            // Runs synchronously inside commitOhlcvData: provenance and
            // position repricing must already be valid for the new dataset.
            const contextKey = dataManager.getLoadedContextKey();
            livePositionsService.syncActiveChartPrice();
            const positions = livePositionsService.getState().positions;
            observations.push({
                contextKey,
                // installPositions stores futures first, spot second.
                futuresPrice: positions[0]!.currentPrice,
                spotPrice: positions[1]!.currentPrice,
            });
        });
    };

    const installFetch = (): { calls: () => number } => {
        let calls = 0;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/api/v3/klines")) {
                return new Response(JSON.stringify(GAP_TIMES.map((time, index) => klineRow(time, 109 + index))), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }
            calls += 1;
            return tickerResponse("65600");
        }) as typeof fetch;
        return { calls: () => calls };
    };

    const installPositions = (): void => {
        livePositionsService.__setOpenPositionsForTests([
            position({
                symbol: "BTCUSDT",
                interval: "4h",
                currentPrice: 200,
                unrealizedPnl: 100,
                unrealizedPnlPercent: 100,
                backtestSettings: { executionModel: "signal_close", binanceMarketType: "futures" } as BacktestSettings,
            }),
            position({
                symbol: "BTCUSDT",
                interval: "4h",
                currentPrice: 200,
                unrealizedPnl: 100,
                unrealizedPnlPercent: 100,
            }),
        ]);
    };

    const setStreamContext = (): void => {
        // The singleton's stream fields are normally owned by startStreaming;
        // the specs drive the update/gap-fill methods directly.
        const internal = dataManager as unknown as {
            streamSymbol: string; streamInterval: string; streamProvider: string;
        };
        internal.streamSymbol = "BTCUSDT";
        internal.streamInterval = "4h";
        internal.streamProvider = "binance";
    };

    const clearStreamContext = (): void => {
        const internal = dataManager as unknown as {
            streamSymbol: string; streamInterval: string; streamProvider: string;
        };
        internal.streamSymbol = "";
        internal.streamInterval = "";
        internal.streamProvider = "";
    };

    beforeEach(() => {
        livePositionsService.__resetLivePriceCachesForTests();
        state.currentSymbol = "BTCUSDT";
        state.currentInterval = "4h";
        state.binanceMarketType = "spot";
        installPositions();
    });

    afterEach(() => {
        unsubscribe?.();
        unsubscribe = null;
        clearStreamContext();
        globalThis.fetch = originalFetch;
        livePositionsService.__resetLivePriceCachesForTests();
        livePositionsService.__setOpenPositionsForTests([]);
        state.currentSymbol = "ETHUSDT";
        state.currentInterval = "1d";
        state.binanceMarketType = "spot";
        state.ohlcvData = [];
        dataManager.__setLoadedContextForTests(null, null);
    });

    it("binds provenance before the first streamed candle publishes", async t => {
        await drain();
        setStreamContext();
        state.ohlcvData = [];
        dataManager.__setLoadedContextForTests("BTCUSDT", "4h", "spot");
        installObserver();
        const transport = installFetch();
        t.mock.method(internals().fetcher, "queuePersistCandles", () => {});
        t.mock.method(uiManager, "updatePriceDisplay", () => {});

        internals().handleStreamUpdate(
            candle(FIRST_CANDLE_TIME, 101),
            (dataManager as unknown as { streamSessionId: number }).streamSessionId,
            "BTCUSDT", "4h", "binance",
        );

        // Inside the publication: provenance is valid and the compatible spot
        // position already carries the streamed close; futures is isolated.
        assert.equal(observations.length, 1);
        assert.equal(observations[0]!.contextKey, "BTCUSDT|4h|spot");
        assert.equal(observations[0]!.spotPrice, 101);
        assert.equal(observations[0]!.futuresPrice, 200);
        // After the method returns the dataset stays provenance-trusted.
        assert.equal(dataManager.getLoadedContextKey(), "BTCUSDT|4h|spot");
        assert.equal(await fetchQuote("BTCUSDT", "binance", "4h"), 101);
        assert.equal(transport.calls(), 0);
    });

    it("binds provenance before a gap-fill republication publishes", async t => {
        await drain();
        setStreamContext();
        state.ohlcvData = CHART_TIMES.map((time, index) => candle(time, 107 + index));
        dataManager.__setLoadedContextForTests("BTCUSDT", "4h", "spot");
        installObserver();
        const transport = installFetch();
        t.mock.method(internals().fetcher, "queuePersistCandles", () => {});
        t.mock.method(uiManager, "updatePriceDisplay", () => {});

        // The incoming bar skips a pair, so handleStreamUpdate triggers the
        // real gap-fill path before this promise settles.
        await internals().handleStreamUpdate(
            candle(INCOMING_TIME, 111),
            (dataManager as unknown as { streamSessionId: number }).streamSessionId,
            "BTCUSDT", "4h", "binance",
        );
        await drain();

        // Inside the merged republication: valid provenance for the merged
        // array, and the compatible spot position reprices to the merged tail.
        assert.equal(observations.length, 1);
        assert.equal(observations[0]!.contextKey, "BTCUSDT|4h|spot");
        assert.equal(observations[0]!.spotPrice, 111);
        assert.equal(observations[0]!.futuresPrice, 200);
        assert.equal(state.ohlcvData.length, 5);
        assert.equal(dataManager.getLoadedContextKey(), "BTCUSDT|4h|spot");
        assert.equal(await fetchQuote("BTCUSDT", "binance", "4h"), 111);
        assert.equal(transport.calls(), 0);
    });

    it("does not let stale context fields promote imported data during a gap fill", async t => {
        await drain();
        setStreamContext();
        state.ohlcvData = CHART_TIMES.map((time, index) => candle(time, 107 + index));
        dataManager.__setLoadedContextForTests("BTCUSDT", "4h", "spot");
        // The normal import lifecycle: publish a replacement array, register it.
        const imported: OHLCVData[] = CHART_TIMES.map((time, index) => candle(time, 150 + index));
        commitOhlcvData(imported, "data_mining_import");
        dataManager.registerImportedData("BTCUSDT", "4h", imported);
        assert.equal(dataManager.getLoadedContextKey(), null, "imported data has no provenance");
        installObserver();
        const transport = installFetch();
        t.mock.method(internals().fetcher, "queuePersistCandles", () => {});
        t.mock.method(uiManager, "updatePriceDisplay", () => {});

        await internals().handleStreamUpdate(
            candle(INCOMING_TIME, 111),
            (dataManager as unknown as { streamSessionId: number }).streamSessionId,
            "BTCUSDT", "4h", "binance",
        );
        await drain();

        // The merged array contains imported bars; the stale BTCUSDT/4h/spot
        // fields must not re-promote it, so no position accepts a chart price.
        assert.equal(observations.length, 1);
        assert.equal(observations[0]!.contextKey, null);
        assert.equal(observations[0]!.spotPrice, 200);
        assert.equal(observations[0]!.futuresPrice, 200);
        assert.equal(dataManager.getLoadedContextKey(), null);
        assert.equal(await fetchQuote("BTCUSDT", "binance", "4h"), 65600);
        assert.equal(transport.calls(), 1);
    });

    it("leaves no sync metadata when an imported dataset exceeds the cache budget", async () => {
        const budgeted = new (await import("../lib/data/data-cache")).DataCache({ maxPoints: 10 });
        const previous = dataManager.__swapDataCacheForTests(budgeted);
        try {
            const oversized: OHLCVData[] = Array.from({ length: 25 }, (_, index) => candle(FIRST_CANDLE_TIME + index * 14400, 100));
            dataManager.registerImportedData("BTCUSDT", "4h", oversized);

            // registerImportedData stamped sync time before admission; the
            // rejected oversized set must not leave the orphan behind.
            assert.equal(budgeted.syncAtByKey.size, 0);
            assert.equal(budgeted.size, 0);
            assert.equal(budgeted.points, 0);
            assert.equal(budgeted.evictions, 0);
        } finally {
            dataManager.__swapDataCacheForTests(previous);
        }
    });
});
