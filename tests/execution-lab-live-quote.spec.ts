import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { executeBacktest } from "../lib/backtest-executor";
import { buildExecutionLabStrategyExecutionContext } from "../lib/execution-lab/execution-lab-strategy-context";
import { startExecutionLabMiner } from "../lib/execution-lab/execution-lab-api";
import {
    __setLogRootForTests,
    buildExecutionLabMinerProcessArgs,
    executionLabVitePlugin,
    isFreshStoredLiveQuote,
    normalizeExecutionLabClobPrice,
} from "../lib/execution-lab/execution-lab-vite-plugin";
import type { ExecutionLabSessionSnapshot } from "../lib/execution-lab/execution-lab-model";
import { isExecutionLabTransientPollError } from "../lib/execution-lab/poll-errors";
import { collectExecutionLabTradeQuoteTimes } from "../lib/execution-lab/trade-quote-times";
import type { PolymarketClob1sQuoteRow } from "../lib/second-market/types";
import type { OHLCVData, Strategy, Time, Trade } from "../lib/types/strategies";

type MockHandler = (req: NodeJS.ReadableStream & {
    method?: string;
    url?: string;
    headers?: Record<string, string>;
    socket?: { remoteAddress?: string } | null;
}, res: {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body?: string): void;
}) => void | Promise<void>;

// Simulated in-browser caller: a loopback peer address (the unforgeable
// signal the auth gate keys off) plus loopback Host + Origin. Set on every
// request so tests exercise the real trust path, not a bypass.
const LOOPBACK_SOCKET = { remoteAddress: "127.0.0.1" };
const LOOPBACK_BROWSER_HEADERS = { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" };

function createHandler(): MockHandler {
    let handler: MockHandler | null = null;
    const plugin = executionLabVitePlugin();
    (plugin.configurePreviewServer as ((server: never) => void) | undefined)?.({
        middlewares: {
            use(prefix: string, registered: MockHandler) {
                if (prefix === "/api/execution-lab") handler = registered;
            },
        },
    } as never);
    if (!handler) throw new Error("Expected execution lab middleware to register");
    return handler;
}

function createDevHandler(): MockHandler {
    let handler: MockHandler | null = null;
    const plugin = executionLabVitePlugin();
    (plugin.configureServer as ((server: never) => void) | undefined)?.({
        middlewares: {
            use(prefix: string, registered: MockHandler) {
                if (prefix === "/api/execution-lab") handler = registered;
            },
        },
    } as never);
    if (!handler) throw new Error("Expected execution lab middleware to register");
    return handler;
}

async function invoke(handler: MockHandler, path: string): Promise<{ statusCode: number; json: any }> {
    return await new Promise((resolve, reject) => {
        const request = Readable.from([]) as NodeJS.ReadableStream & {
            method?: string;
            url?: string;
            headers?: Record<string, string>;
            socket?: { remoteAddress?: string } | null;
        };
        request.method = "GET";
        request.url = path;
        // Simulate the in-browser caller: loopback peer + loopback Host +
        // loopback Origin so the mutation-route auth gate accepts.
        request.headers = { ...LOOPBACK_BROWSER_HEADERS };
        request.socket = LOOPBACK_SOCKET;
        const response = {
            statusCode: 200,
            setHeader() {},
            end(rawBody?: string) {
                try {
                    resolve({ statusCode: response.statusCode, json: rawBody ? JSON.parse(rawBody) : null });
                } catch (error) {
                    reject(error);
                }
            },
        };
        Promise.resolve(handler(request, response)).catch(reject);
    });
}

async function invokePost(handler: MockHandler, path: string, body: unknown): Promise<{ statusCode: number; json: any }> {
    return await new Promise((resolve, reject) => {
        const request = Readable.from([JSON.stringify(body)]) as NodeJS.ReadableStream & {
            method?: string;
            url?: string;
            headers?: Record<string, string>;
            socket?: { remoteAddress?: string } | null;
        };
        request.method = "POST";
        request.url = path;
        // Loopback peer + Host + Origin (browser caller) + application/json,
        // matching the mutation-route auth gate and JSON content-type enforcement.
        request.headers = { ...LOOPBACK_BROWSER_HEADERS, "content-type": "application/json" };
        request.socket = LOOPBACK_SOCKET;
        const response = {
            statusCode: 200,
            setHeader() {},
            end(rawBody?: string) {
                try {
                    resolve({ statusCode: response.statusCode, json: rawBody ? JSON.parse(rawBody) : null });
                } catch (error) {
                    reject(error);
                }
            },
        };
        Promise.resolve(handler(request, response)).catch(reject);
    });
}

// Posts a raw (pre-serialized or malformed) body with explicit headers, so the
// parser's 400/413 paths can be exercised. See audit finding 3.
async function invokePostRaw(
    handler: MockHandler,
    path: string,
    rawBody: string,
    headers: Record<string, string> = {}
): Promise<{ statusCode: number; json: any }> {
    return await new Promise((resolve, reject) => {
        const request = Readable.from([rawBody]) as NodeJS.ReadableStream & {
            method?: string;
            url?: string;
            headers?: Record<string, string>;
            socket?: { remoteAddress?: string } | null;
        };
        request.method = "POST";
        request.url = path;
        // Default to a loopback browser caller so tests reach the body parser
        // (the auth gate would otherwise reject and mask the parser behavior).
        // Callers can still pass explicit headers to override.
        request.headers = { ...LOOPBACK_BROWSER_HEADERS, "content-type": "application/json", ...headers };
        request.socket = LOOPBACK_SOCKET;
        const response = {
            statusCode: 200,
            setHeader() {},
            end(rawEndBody?: string) {
                try {
                    resolve({ statusCode: response.statusCode, json: rawEndBody ? JSON.parse(rawEndBody) : null });
                } catch (error) {
                    reject(error);
                }
            },
        };
        Promise.resolve(handler(request, response)).catch(reject);
    });
}

function trade(id: number, entryTime: number, exitTime: number, exitReason: Trade["exitReason"]): Trade {
    return {
        id,
        type: "long",
        entryTime: entryTime as Time,
        entryPrice: 100,
        exitTime: exitTime as Time,
        exitPrice: 101,
        pnl: 1,
        pnlPercent: 1,
        size: 1,
        exitReason,
    };
}

function sessionSnapshot(): ExecutionLabSessionSnapshot {
    return {
        sessionId: "session-1",
        symbol: "BTCUSDT",
        outcomeSymbol: "BTCUSDT",
        interval: "1s",
        strategyKey: "context_strategy",
        strategyName: "Context Strategy",
        params: {},
        backtestSettings: { executionModel: "signal_close" },
        capitalSettings: {
            initialCapital: 10000,
            positionSize: 100,
            commission: 0,
            sizingMode: "percent",
            fixedTradeAmount: 0,
        },
        polymarketSettings: {},
        outcomeInterval: "5m",
        seriesId: "10684",
        exitMode: "resolve_hold",
        allowMultipleTradesPerEvent: false,
        stakeUsd: 5,
        startedAtIso: "2026-01-01T00:00:00.000Z",
    };
}

function clobQuote(sampleTs: number): PolymarketClob1sQuoteRow {
    return {
        series_id: "10684",
        symbol: "BTCUSDT",
        outcome_interval: "5m",
        event_start_ts: sampleTs - 10,
        event_end_ts: sampleTs + 290,
        condition_id: "condition",
        market_slug: "btc-event",
        yes_token_id: "yes",
        no_token_id: "no",
        sample_ts: sampleTs,
        yes_bid: 0.51,
        yes_ask: 0.53,
        yes_mid: 0.52,
        yes_last: null,
        no_bid: 0.47,
        no_ask: 0.49,
        no_mid: 0.48,
        no_last: null,
        source: "polymarket_clob_live",
        source_ts_ms: sampleTs * 1000,
        quote_age_ms: 0,
        quality_flags: "",
        updated_at: sampleTs,
    };
}

function liveTradeRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
        requestId: "live-request-1",
        sessionId: "session-1",
        paperTradeId: "paper-1",
        createdAtIso: new Date(nowSec * 1000).toISOString(),
        expiresAtSec: nowSec + 10,
        symbol: "BTCUSDT",
        strategyKey: "test_strategy",
        eventStartTs: nowSec - 20,
        eventEndTs: nowSec + 280,
        marketSlug: "btc-event",
        conditionId: "condition",
        tokenId: "yes-token",
        side: "yes",
        stakeUsd: 5,
        signalTimeSec: nowSec - 2,
        entryTimeSec: nowSec - 1,
        orderMode: "taker",
        maxPrice: 0.55,
        orderType: "FAK",
        ...overrides,
    };
}

async function startLiveTestSession(handler: MockHandler): Promise<string> {
    const response = await invokePost(handler, "/session/start", {
        strategyKey: "test_strategy",
        symbol: "BTCUSDT",
        startedAtIso: new Date().toISOString(),
    });
    expect(response.statusCode).to.equal(200);
    return String(response.json.sessionId);
}

function withEnv<T>(updates: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
    const previous = new Map<string, string | undefined>();
    const isolatedUpdates = {
        ...updates,
        EXECUTION_LAB_LIVE_IGNORE_REPO_ENV: "1",
    };
    for (const [key, value] of Object.entries(isolatedUpdates)) {
        previous.set(key, process.env[key]);
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
    return run().finally(() => {
        for (const [key, value] of previous.entries()) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    });
}

// Redirect session-log writes to a per-spec tempdir so the spec that exercises
// `/session/start` + `/logs` never writes into or removes the production
// `logs/paper-execution/` tree (audit Finding 3). The seam is cleared in
// `afterEach` so other tests are unaffected.
let logRoot = "";
beforeEach(() => {
    logRoot = mkdtempSync(resolve(tmpdir(), "sf-execution-lab-log-"));
    __setLogRootForTests(logRoot);
});
afterEach(() => {
    __setLogRootForTests(null);
    if (logRoot) {
        rmSync(logRoot, { recursive: true, force: true });
        logRoot = "";
    }
});

describe("Execution Lab live helpers", () => {
    it("preserves zero CLOB prices as valid boundary prices", () => {
        expect(normalizeExecutionLabClobPrice(0)).to.equal(0);
        expect(normalizeExecutionLabClobPrice("0")).to.equal(0);
        expect(normalizeExecutionLabClobPrice(1)).to.equal(1);
    });

    it("rejects invalid CLOB prices", () => {
        expect(normalizeExecutionLabClobPrice(-0.01)).to.equal(null);
        expect(normalizeExecutionLabClobPrice(1.01)).to.equal(null);
        expect(normalizeExecutionLabClobPrice("")).to.equal(null);
    });

    it("rejects carried-forward and old stored live quotes as fresh quotes", () => {
        const nowSec = Math.floor(Date.now() / 1000);
        expect(isFreshStoredLiveQuote({
            ...clobQuote(nowSec),
            source_ts_ms: Date.now(),
            quote_age_ms: 0,
            quality_flags: "",
        })).to.equal(true);
        expect(isFreshStoredLiveQuote({
            ...clobQuote(nowSec),
            source_ts_ms: Date.now(),
            quote_age_ms: 0,
            quality_flags: "carried_forward",
        })).to.equal(false);
        expect(isFreshStoredLiveQuote({
            ...clobQuote(nowSec),
            source_ts_ms: Date.now() - 5_000,
            quote_age_ms: 5_000,
            quality_flags: "",
        })).to.equal(false);
    });

    it("rejects stored live quotes with null bid/ask as not fresh", () => {
        const nowSec = Math.floor(Date.now() / 1000);
        const base = {
            ...clobQuote(nowSec),
            source_ts_ms: Date.now(),
            quote_age_ms: 0,
            quality_flags: "",
        };
        expect(isFreshStoredLiveQuote(base)).to.equal(true);
        expect(isFreshStoredLiveQuote({ ...base, yes_bid: null, yes_ask: null })).to.equal(false);
        expect(isFreshStoredLiveQuote({ ...base, yes_bid: null })).to.equal(false);
        expect(isFreshStoredLiveQuote({ ...base, yes_ask: null })).to.equal(false);
        expect(isFreshStoredLiveQuote({ ...base, no_bid: null, no_ask: null })).to.equal(false);
        expect(isFreshStoredLiveQuote({ ...base, no_bid: null })).to.equal(false);
        expect(isFreshStoredLiveQuote({ ...base, no_ask: null })).to.equal(false);
    });

    it("loads closed outcomes by event end date", async () => {
        const handler = createHandler();
        const originalFetch = globalThis.fetch;
        let requestedUrl: URL | null = null;
        globalThis.fetch = (async (input) => {
            requestedUrl = new URL(String(input));
            return new Response(JSON.stringify([{
                slug: "btc-updown-5m-1700000100",
                endDate: new Date(1_700_000_400 * 1000).toISOString(),
                markets: [{
                    id: "market-1",
                    slug: "btc-updown-5m-1700000100",
                    conditionId: "condition-1",
                    outcomes: JSON.stringify(["Up", "Down"]),
                    clobTokenIds: JSON.stringify(["yes-token", "no-token"]),
                    outcomePrices: JSON.stringify(["0.99", "0.01"]),
                }],
            }]));
        }) as typeof fetch;

        try {
            const response = await invoke(
                handler,
                "/live-outcomes?symbol=BTCUSDT&outcomeInterval=5m&seriesId=10684&startTs=1700000340&endTs=1700000460"
            );

            expect(response.statusCode).to.equal(200);
            const url = requestedUrl as URL | null;
            expect(url?.searchParams.get("end_date_min")).to.not.equal(null);
            expect(url?.searchParams.get("start_date_min")).to.equal(null);
            expect(response.json.outcomes).to.have.length(1);
            expect(response.json.outcomes[0].event_end_ts).to.equal(1_700_000_400);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it("coalesces repeated live outcome requests through the middleware cache", async () => {
        const handler = createHandler();
        const originalFetch = globalThis.fetch;
        let fetchCount = 0;
        globalThis.fetch = (async () => {
            fetchCount += 1;
            return new Response(JSON.stringify([{
                slug: "btc-updown-5m-1700000100",
                endDate: new Date(1_700_000_400 * 1000).toISOString(),
                markets: [{
                    id: "market-1",
                    slug: "btc-updown-5m-1700000100",
                    conditionId: "condition-1",
                    outcomes: JSON.stringify(["Up", "Down"]),
                    clobTokenIds: JSON.stringify(["yes-token", "no-token"]),
                    outcomePrices: JSON.stringify(["0.99", "0.01"]),
                }],
            }]));
        }) as typeof fetch;

        try {
            const path = "/live-outcomes?symbol=BTCUSDT&outcomeInterval=5m&seriesId=10684&startTs=1700000340&endTs=1700000460";
            const first = await invoke(handler, path);
            const second = await invoke(handler, path);

            expect(first.statusCode).to.equal(200);
            expect(second.statusCode).to.equal(200);
            expect(fetchCount).to.equal(1);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it("rejects unsupported live stream symbols instead of silently using BTCUSDT", async () => {
        const handler = createHandler();
        const response = await invoke(handler, "/live-candles?symbol=DOGEUSDT&limit=1");

        expect(response.statusCode).to.equal(400);
        expect(response.json.error).to.include("symbol");
    });

    it("requests the latest closed 1s candle without an extra one-second live delay", async () => {
        const handler = createHandler();
        const originalFetch = globalThis.fetch;
        const originalNow = Date.now;
        const nowSec = 2_100_000_000;
        let requestedEndTime: string | null = null;
        Date.now = () => nowSec * 1000;
        globalThis.fetch = (async (input) => {
            const url = new URL(
                typeof input === "string"
                    ? input
                    : input instanceof URL
                        ? input.toString()
                        : input.url
            );
            expect(url.pathname).to.equal("/api/v3/klines");
            requestedEndTime = url.searchParams.get("endTime");
            return new Response(JSON.stringify([
                [(nowSec - 1) * 1000, "100", "101", "99", "100.5", "1", 0, 0, 2],
            ]), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }) as typeof fetch;

        try {
            const response = await invoke(
                handler,
                `/live-candles?symbol=BTCUSDT&startTs=${nowSec - 1}&limit=1`
            );

            expect(response.statusCode).to.equal(200);
            expect(requestedEndTime).to.equal(String((nowSec - 1) * 1000));
            expect(response.json.candles.map((row: { ts: number }) => row.ts)).to.deep.equal([nowSec - 1]);
        } finally {
            Date.now = originalNow;
            globalThis.fetch = originalFetch;
        }
    });

    it("requests the latest closed futures 1s candle without an extra one-second live delay", async () => {
        const handler = createHandler();
        const originalFetch = globalThis.fetch;
        const originalNow = Date.now;
        const nowSec = 2_100_000_000;
        let requestedStartTime: string | null = null;
        let requestedEndTime: string | null = null;
        Date.now = () => nowSec * 1000;
        globalThis.fetch = (async (input) => {
            const url = new URL(
                typeof input === "string"
                    ? input
                    : input instanceof URL
                        ? input.toString()
                        : input.url
            );
            expect(url.pathname).to.equal("/fapi/v1/aggTrades");
            requestedStartTime = url.searchParams.get("startTime");
            requestedEndTime = url.searchParams.get("endTime");
            return new Response(JSON.stringify([
                { a: 10, p: "100.5", q: "1", f: 100, l: 100, T: (nowSec - 1) * 1000 + 100 },
            ]), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }) as typeof fetch;

        try {
            const response = await invoke(
                handler,
                `/live-candles?symbol=BTCUSDT&marketType=futures&startTs=${nowSec - 1}&limit=1`
            );

            expect(response.statusCode).to.equal(200);
            expect(requestedStartTime).to.equal(String((nowSec - 1) * 1000));
            expect(requestedEndTime).to.equal(String((nowSec - 1) * 1000 + 999));
            expect(response.json.candles.map((row: { ts: number }) => row.ts)).to.deep.equal([nowSec - 1]);
        } finally {
            Date.now = originalNow;
            globalThis.fetch = originalFetch;
        }
    });

    it("builds futures live 1s candles from aggregate trades", async () => {
        const handler = createHandler();
        const originalFetch = globalThis.fetch;
        const requestedPaths: string[] = [];
        globalThis.fetch = (async (input) => {
            const url = new URL(
                typeof input === "string"
                    ? input
                    : input instanceof URL
                        ? input.toString()
                        : input.url
            );
            requestedPaths.push(url.pathname);
            expect(url.pathname).to.equal("/fapi/v1/aggTrades");
            expect(url.searchParams.get("interval")).to.equal(null);
            return new Response(JSON.stringify([
                { a: 10, p: "100", q: "1.5", f: 100, l: 101, T: 1_700_000_000_100 },
                { a: 11, p: "102", q: "2", f: 102, l: 102, T: 1_700_000_002_250 },
                { a: 12, p: "101", q: "0.5", f: 103, l: 103, T: 1_700_000_002_500 },
            ]), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }) as typeof fetch;

        try {
            const response = await invoke(
                handler,
                "/live-candles?symbol=BTCUSDT&marketType=futures&startTs=1700000000&endTs=1700000002&limit=3"
            );

            expect(response.statusCode).to.equal(200);
            expect(response.json.marketType).to.equal("futures");
            expect(requestedPaths).to.deep.equal(["/fapi/v1/aggTrades"]);
            expect(response.json.candles.map((row: { ts: number }) => row.ts)).to.deep.equal([
                1_700_000_000,
                1_700_000_001,
                1_700_000_002,
            ]);
            expect(response.json.candles[1]).to.include({ close: 100, volume: 0 });
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it("labels live event DNS failures by upstream source", async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () => {
            const cause = Object.assign(new Error("getaddrinfo EAI_AGAIN gamma-api.polymarket.com"), {
                code: "EAI_AGAIN",
            });
            const error = new Error("fetch failed") as Error & { cause?: unknown };
            error.cause = cause;
            throw error;
        }) as typeof fetch;

        try {
            const handler = createHandler();
            const response = await invoke(
                handler,
                "/live-events?symbol=BTCUSDT&outcomeInterval=5m&seriesId=dns-test-series"
            );

            expect(response.statusCode).to.equal(500);
            expect(response.json.error).to.include("Gamma live events fetch DNS lookup failed");
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it("passes the selected market type when starting the 1s miner", async () => {
        const originalFetch = globalThis.fetch;
        let requestBody: unknown = null;
        globalThis.fetch = (async (input, init) => {
            expect(String(input)).to.include("/api/execution-lab/miner/start");
            requestBody = JSON.parse(String(init?.body ?? "{}"));
            return new Response(JSON.stringify({
                ok: true,
                running: true,
                pid: 123,
                startedAtIso: "2026-05-20T00:00:00.000Z",
                logPath: "miner.log",
                dbPath: "second-market-data.sqlite",
                exitCode: null,
                marketType: "futures",
                message: "Running",
            }), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        }) as typeof fetch;

        try {
            const status = await startExecutionLabMiner({ marketType: "futures" });
            expect(requestBody).to.deep.equal({ marketType: "futures" });
            expect(status.marketType).to.equal("futures");
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it("reports miner start aborts as endpoint timeouts", async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () => {
            throw new DOMException("The user aborted a request.", "AbortError");
        }) as typeof fetch;

        try {
            await startExecutionLabMiner({ marketType: "futures" });
            throw new Error("Expected startExecutionLabMiner to fail");
        } catch (error) {
            expect(error).to.be.instanceOf(Error);
            expect((error as Error).message).to.equal("/api/execution-lab/miner/start timed out after 30000ms");
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it("includes the selected market type in spawned miner args", () => {
        const args = buildExecutionLabMinerProcessArgs("futures");
        const marketTypeIndex = args.indexOf("--market-type");
        const outcomeIntervalsIndex = args.indexOf("--outcome-intervals");
        const binanceDnsIndex = args.indexOf("--binance-dns");

        expect(marketTypeIndex).to.be.greaterThan(-1);
        expect(args[marketTypeIndex + 1]).to.equal("futures");
        expect(outcomeIntervalsIndex).to.be.greaterThan(-1);
        expect(args[outcomeIntervalsIndex + 1]).to.equal("5m,15m");
        expect(binanceDnsIndex).to.be.greaterThan(-1);
        expect(args[binanceDnsIndex + 1]).to.equal("adguard-doh");
    });

    it("reports idle miner status without starting a process", async () => {
        const handler = createHandler();
        const response = await invoke(handler, "/miner/status");

        expect(response.statusCode).to.equal(200);
        expect(response.json.running).to.equal(false);
        expect(response.json.dbPath).to.include("second-market-data.sqlite");
    });

    it("reports live executor status without starting the executor", async () => {
        await withEnv({
            EXECUTION_LAB_LIVE_EXECUTOR_PATH: process.execPath,
            EXECUTION_LAB_LIVE_ENABLED: "0",
            EXECUTION_LAB_LIVE_ORDER_TYPE: "FOK",
        }, async () => {
            const handler = createHandler();
            const response = await invoke(handler, "/live/status");

            expect(response.statusCode).to.equal(200);
            expect(response.json.available).to.equal(true);
            expect(response.json.dryRun).to.equal(true);
            expect(response.json.orderType).to.equal("FOK");
        });
    });

    it("resolves UI live config overrides without exposing executor paths", async () => {
        await withEnv({
            EXECUTION_LAB_LIVE_EXECUTOR_PATH: process.execPath,
            EXECUTION_LAB_LIVE_ENABLED: "0",
            EXECUTION_LAB_LIVE_ORDER_TYPE: "FAK",
            EXECUTION_LAB_LIVE_MAX_STAKE_USD: "10",
        }, async () => {
            const handler = createDevHandler();
            const response = await invokePost(handler, "/live/config/resolve", {
                liveConfig: {
                    orderMode: "limit",
                    takerOrderType: "FOK",
                    sizingMode: "exchange_min",
                    maxStakeUsd: 7,
                    entryMaxSlippageCents: 3,
                    exitMaxSlippageCents: 4,
                    limitOffsetEnabled: true,
                    limitOffsetCents: 6,
                    limitFixedPriceEnabled: false,
                    limitFixedPriceCents: 20,
                    limitCancelAllOnExitEnabled: true,
                },
            });

            expect(response.statusCode).to.equal(200);
            expect(response.json.orderMode).to.equal("limit");
            expect(response.json.takerOrderType).to.equal("FOK");
            expect(response.json.maxStakeUsd).to.equal(7);
            expect(response.json.liveEnabled).to.equal(false);
            expect("executorPath" in response.json).to.equal(false);
        });
    });

    it("does not register live trade submission in preview mode by default", async () => {
        await withEnv({ EXECUTION_LAB_ALLOW_LIVE_TRADE_PREVIEW: undefined }, async () => {
            const handler = createHandler();
            const response = await invokePost(handler, "/live/trade", liveTradeRequest());

            expect(response.statusCode).to.equal(404);
        });
    });

    it("rejects malformed live trade requests before invoking the executor", async () => {
        const handler = createDevHandler();
        const sessionId = await startLiveTestSession(handler);
        const response = await invokePost(handler, "/live/trade", {
            ...liveTradeRequest({ sessionId }),
            orderType: "GTC",
        });

        expect(response.statusCode).to.equal(400);
        expect(response.json.error).to.include("orderType");
    });

    it("rejects live submissions for unknown sessions before executor validation", async () => {
        const handler = createDevHandler();
        const response = await invokePost(handler, "/live/trade", {
            ...liveTradeRequest({ sessionId: "missing-session" }),
            orderType: "GTC",
        });

        expect(response.statusCode).to.equal(404);
        expect(response.json.error).to.equal("Unknown execution lab session");
    });

    it("rejects live trade requests that do not match the configured order type", async () => {
        await withEnv({
            EXECUTION_LAB_LIVE_ORDER_TYPE: "FOK",
            EXECUTION_LAB_LIVE_MAX_STAKE_USD: "10",
        }, async () => {
            const handler = createDevHandler();
            const sessionId = await startLiveTestSession(handler);
            const response = await invokePost(handler, "/live/trade", liveTradeRequest({ sessionId }));

            expect(response.statusCode).to.equal(200);
            expect(response.json.status).to.equal("rejected");
            expect(response.json.reason).to.equal("order_type_config_mismatch");
        });
    });

    it("maps missing live executor and executor timeout to structured trade results", async () => {
        await withEnv({
            EXECUTION_LAB_LIVE_EXECUTOR_PATH: "Z:\\missing\\live_trade_once.exe",
            EXECUTION_LAB_LIVE_MAX_STAKE_USD: "10",
            EXECUTION_LAB_LIVE_ORDER_TYPE: "FAK",
            EXECUTION_LAB_LIVE_TIMEOUT_MS: "50",
        }, async () => {
            const handler = createDevHandler();
            const sessionId = await startLiveTestSession(handler);
            const response = await invokePost(handler, "/live/trade", liveTradeRequest({ sessionId }));

            expect(response.statusCode).to.equal(200);
            expect(response.json.status).to.equal("failed");
            expect(response.json.reason).to.equal("executor_unavailable");
        });

        await withEnv({
            EXECUTION_LAB_LIVE_EXECUTOR_PATH: process.execPath,
            EXECUTION_LAB_LIVE_EXECUTOR_ARGS_JSON: JSON.stringify(["-e", "setTimeout(() => {}, 10000);"]),
            EXECUTION_LAB_LIVE_MAX_STAKE_USD: "10",
            EXECUTION_LAB_LIVE_ORDER_TYPE: "FAK",
            EXECUTION_LAB_LIVE_TIMEOUT_MS: "50",
        }, async () => {
            const handler = createDevHandler();
            const sessionId = await startLiveTestSession(handler);
            const response = await invokePost(handler, "/live/trade", liveTradeRequest({ sessionId }));

            expect(response.statusCode).to.equal(200);
            expect(response.json.status).to.equal("failed");
            expect(response.json.reason).to.equal("executor_timeout");
        });
    });

    it("coalesces duplicate live trade request ids before invoking the executor twice", async () => {
        const dir = mkdtempSync(join(tmpdir(), "execution-lab-ledger-"));
        const countPath = join(dir, "count.txt");
        const script = [
            "const fs = require('node:fs');",
            "let body='';",
            "process.stdin.on('data', c => body += c);",
            "process.stdin.on('end', () => {",
            `fs.appendFileSync(${JSON.stringify(countPath)}, 'x');`,
            "const req = JSON.parse(body);",
            "console.log(JSON.stringify({ ok: true, requestId: req.requestId, status: 'dry_run', currentAsk: 0.52, maxPrice: req.maxPrice }));",
            "});",
        ].join("");

        try {
            await withEnv({
                EXECUTION_LAB_LIVE_EXECUTOR_PATH: process.execPath,
                EXECUTION_LAB_LIVE_EXECUTOR_ARGS_JSON: JSON.stringify(["-e", script]),
                EXECUTION_LAB_LIVE_MAX_STAKE_USD: "10",
                EXECUTION_LAB_LIVE_ORDER_TYPE: "FAK",
            }, async () => {
                const handler = createDevHandler();
                const sessionId = await startLiveTestSession(handler);
                const request = liveTradeRequest({ sessionId });
                const first = await invokePost(handler, "/live/trade", request);
                const second = await invokePost(handler, "/live/trade", request);

                expect(first.statusCode).to.equal(200);
                expect(second.statusCode).to.equal(200);
                expect(first.json.status).to.equal("dry_run");
                expect(second.json.status).to.equal("dry_run");
                expect(readFileSync(countPath, "utf8")).to.equal("x");
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("submits limit cancel-all once with a matching UI config", async () => {
        const dir = mkdtempSync(join(tmpdir(), "execution-lab-cancel-ledger-"));
        const countPath = join(dir, "cancel-count.txt");
        const script = [
            "const fs = require('node:fs');",
            "let body='';",
            "process.stdin.on('data', c => body += c);",
            "process.stdin.on('end', () => {",
            `fs.appendFileSync(${JSON.stringify(countPath)}, 'x');`,
            "const req = JSON.parse(body);",
            "console.log(JSON.stringify({ ok: true, requestId: req.requestId, status: 'submitted', scope: req.scope, canceledCount: 1 }));",
            "});",
        ].join("");

        try {
            await withEnv({
                EXECUTION_LAB_LIVE_EXECUTOR_PATH: process.execPath,
                EXECUTION_LAB_LIVE_EXECUTOR_ARGS_JSON: JSON.stringify(["-e", script]),
                EXECUTION_LAB_LIVE_CANCEL_SCOPE: "token",
            }, async () => {
                const handler = createDevHandler();
                const sessionId = await startLiveTestSession(handler);
                const request = {
                    action: "cancel_all",
                    requestId: "cancel-1",
                    sessionId,
                    paperTradeId: "paper-1",
                    exitTriggerKey: `${sessionId}|event|yes|paper-1|exit`,
                    createdAtIso: new Date().toISOString(),
                    symbol: "BTCUSDT",
                    strategyKey: "test_strategy",
                    marketSlug: "btc-event",
                    conditionId: "condition",
                    tokenId: "yes-token",
                    scope: "token",
                    reason: "limit_exit_signal",
                    orderMode: "limit",
                    liveConfig: {
                        orderMode: "limit",
                        takerOrderType: "FAK",
                        sizingMode: "fixed",
                        maxStakeUsd: 10,
                        entryMaxSlippageCents: 1,
                        exitMaxSlippageCents: 5,
                        limitOffsetEnabled: false,
                        limitOffsetCents: 0,
                        limitFixedPriceEnabled: false,
                        limitFixedPriceCents: 20,
                        limitCancelAllOnExitEnabled: true,
                    },
                };
                const first = await invokePost(handler, "/live/cancel-all", request);
                const second = await invokePost(handler, "/live/cancel-all", request);

                expect(first.statusCode).to.equal(200);
                expect(second.statusCode).to.equal(200);
                expect(first.json.status).to.equal("submitted");
                expect(second.json.status).to.equal("submitted");
                expect(readFileSync(countPath, "utf8")).to.equal("x");
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("accepts targeted session cancel-all without a configured broad cancel scope", async () => {
        const script = [
            "let body='';",
            "process.stdin.on('data', c => body += c);",
            "process.stdin.on('end', () => {",
            "const req = JSON.parse(body);",
            "console.log(JSON.stringify({ ok: true, requestId: req.requestId, status: 'submitted', scope: req.scope, canceledOrderIds: req.orderIds, canceledCount: req.orderIds.length }));",
            "});",
        ].join("");

        await withEnv({
            EXECUTION_LAB_LIVE_EXECUTOR_PATH: process.execPath,
            EXECUTION_LAB_LIVE_EXECUTOR_ARGS_JSON: JSON.stringify(["-e", script]),
            EXECUTION_LAB_LIVE_CANCEL_SCOPE: undefined,
        }, async () => {
            const handler = createDevHandler();
            const sessionId = await startLiveTestSession(handler);
            const response = await invokePost(handler, "/live/cancel-all", {
                action: "cancel_all",
                requestId: "cancel-session-1",
                sessionId,
                paperTradeId: "paper-1",
                exitTriggerKey: `${sessionId}|event|yes|paper-1|exit`,
                createdAtIso: new Date().toISOString(),
                symbol: "BTCUSDT",
                strategyKey: "test_strategy",
                marketSlug: "btc-event",
                conditionId: "condition",
                tokenId: "yes-token",
                orderIds: ["0xabc"],
                scope: "session",
                reason: "limit_exit_signal",
                orderMode: "limit",
                liveConfig: {
                    orderMode: "limit",
                    takerOrderType: "FAK",
                    sizingMode: "fixed",
                    maxStakeUsd: 10,
                    entryMaxSlippageCents: 1,
                    exitMaxSlippageCents: 5,
                    limitOffsetEnabled: false,
                    limitOffsetCents: 0,
                    limitFixedPriceEnabled: false,
                    limitFixedPriceCents: 20,
                    limitCancelAllOnExitEnabled: true,
                },
            });

            expect(response.statusCode).to.equal(200);
            expect(response.json.status).to.equal("submitted");
            expect(response.json.scope).to.equal("session");
            expect(response.json.canceledOrderIds).to.deep.equal(["0xabc"]);
        });
    });

    it("rejects limit cancel-all when cancel-on-exit is disabled", async () => {
        await withEnv({
            EXECUTION_LAB_LIVE_EXECUTOR_PATH: process.execPath,
            EXECUTION_LAB_LIVE_CANCEL_SCOPE: "token",
        }, async () => {
            const handler = createDevHandler();
            const sessionId = await startLiveTestSession(handler);
            const response = await invokePost(handler, "/live/cancel-all", {
                action: "cancel_all",
                requestId: "cancel-disabled-1",
                sessionId,
                paperTradeId: "paper-1",
                exitTriggerKey: `${sessionId}|event|yes|paper-1|exit`,
                createdAtIso: new Date().toISOString(),
                symbol: "BTCUSDT",
                strategyKey: "test_strategy",
                marketSlug: "btc-event",
                conditionId: "condition",
                tokenId: "yes-token",
                scope: "token",
                reason: "limit_exit_signal",
                orderMode: "limit",
                liveConfig: {
                    orderMode: "limit",
                    takerOrderType: "FAK",
                    sizingMode: "fixed",
                    maxStakeUsd: 10,
                    entryMaxSlippageCents: 1,
                    exitMaxSlippageCents: 5,
                    limitOffsetEnabled: false,
                    limitOffsetCents: 0,
                    limitFixedPriceEnabled: false,
                    limitFixedPriceCents: 20,
                    limitCancelAllOnExitEnabled: false,
                },
            });

            expect(response.statusCode).to.equal(400);
            expect(response.json.error).to.equal("limit cancel-all-on-exit is disabled");
        });
    });

    it("rejects limit cancel-all when cancel scope is not configured", async () => {
        await withEnv({
            EXECUTION_LAB_LIVE_EXECUTOR_PATH: process.execPath,
            EXECUTION_LAB_LIVE_CANCEL_SCOPE: undefined,
        }, async () => {
            const handler = createDevHandler();
            const sessionId = await startLiveTestSession(handler);
            const response = await invokePost(handler, "/live/cancel-all", {
                action: "cancel_all",
                requestId: "cancel-no-scope-1",
                sessionId,
                paperTradeId: "paper-1",
                exitTriggerKey: `${sessionId}|event|yes|paper-1|exit`,
                createdAtIso: new Date().toISOString(),
                symbol: "BTCUSDT",
                strategyKey: "test_strategy",
                marketSlug: "btc-event",
                conditionId: "condition",
                tokenId: "yes-token",
                scope: "unknown",
                reason: "limit_exit_signal",
                orderMode: "limit",
                liveConfig: {
                    orderMode: "limit",
                    takerOrderType: "FAK",
                    sizingMode: "fixed",
                    maxStakeUsd: 10,
                    entryMaxSlippageCents: 1,
                    exitMaxSlippageCents: 5,
                    limitOffsetEnabled: false,
                    limitOffsetCents: 0,
                    limitFixedPriceEnabled: false,
                    limitFixedPriceCents: 20,
                    limitCancelAllOnExitEnabled: true,
                },
            });

            expect(response.statusCode).to.equal(400);
            expect(response.json.error).to.equal("cancel scope must be configured");
        });
    });

    it("rejects duplicate live request ids with a different payload hash", async () => {
        await withEnv({
            EXECUTION_LAB_LIVE_EXECUTOR_PATH: process.execPath,
            EXECUTION_LAB_LIVE_EXECUTOR_ARGS_JSON: JSON.stringify(["-e", [
                "let body='';",
                "process.stdin.on('data', c => body += c);",
                "process.stdin.on('end', () => {",
                "const req = JSON.parse(body);",
                "console.log(JSON.stringify({ ok: true, requestId: req.requestId, status: 'dry_run' }));",
                "});",
            ].join("")]),
            EXECUTION_LAB_LIVE_MAX_STAKE_USD: "10",
            EXECUTION_LAB_LIVE_ORDER_TYPE: "FAK",
        }, async () => {
            const handler = createDevHandler();
            const sessionId = await startLiveTestSession(handler);
            const first = await invokePost(handler, "/live/trade", liveTradeRequest({ sessionId }));
            const second = await invokePost(handler, "/live/trade", liveTradeRequest({ sessionId, stakeUsd: 6 }));
            const third = await invokePost(handler, "/live/trade", {
                ...liveTradeRequest({ sessionId }),
                liveConfig: {
                    orderMode: "taker",
                    takerOrderType: "FAK",
                    sizingMode: "exchange_min",
                    maxStakeUsd: 10,
                    entryMaxSlippageCents: 1,
                    exitMaxSlippageCents: 5,
                    limitOffsetEnabled: false,
                    limitOffsetCents: 0,
                    limitFixedPriceEnabled: false,
                    limitFixedPriceCents: 20,
                    limitCancelAllOnExitEnabled: false,
                },
            });

            expect(first.statusCode).to.equal(200);
            expect(second.statusCode).to.equal(200);
            expect(second.json.status).to.equal("rejected");
            expect(second.json.reason).to.equal("request_id_payload_mismatch");
            expect(third.statusCode).to.equal(200);
            expect(third.json.status).to.equal("rejected");
            expect(third.json.reason).to.equal("request_id_payload_mismatch");
        });
    });

    it("rejects unsupported session symbols before creating a log", async () => {
        const handler = createHandler();
        const response = await invokePost(handler, "/session/start", {
            strategyKey: "test_strategy",
            symbol: "DOGEUSDT",
            startedAtIso: "2026-01-01T00:00:00.000Z",
        });

        expect(response.statusCode).to.equal(400);
        expect(response.json.error).to.include("symbol");
    });

    it("rejects stale live quote requests instead of labeling the current book as historical", async () => {
        const handler = createHandler();
        const response = await invoke(
            handler,
            "/live-quote?symbol=BTCUSDT&outcomeInterval=5m&seriesId=10684&eventStartTs=1700000000&eventEndTs=1700000300&marketSlug=btc-event&yesTokenId=yes&noTokenId=no&sampleTs=1700000010"
        );

        expect(response.statusCode).to.equal(409);
        expect(response.json.error).to.include("stored second-market quotes");
    });

    it("appends batched log records and closes the session", async () => {
        const handler = createHandler();
        const started = await invokePost(handler, "/session/start", {
            strategyKey: "test_strategy",
            symbol: "BTCUSDT",
            startedAtIso: "2026-01-01T00:00:00.000Z",
        });
        const logPath = String(started.json.logPath);

        try {
            const base = {
                sessionId: started.json.sessionId,
                recordedAtIso: "2026-01-01T00:00:01.000Z",
                symbol: "BTCUSDT",
                interval: "1s",
                strategyKey: "test_strategy",
            };
            const response = await invokePost(handler, "/logs", {
                records: [
                    {
                        ...base,
                        recordType: "signal_seen",
                        signalTimeSec: 1_700_000_100,
                        signalType: "buy",
                        signalPrice: 100,
                        candleClose: 100,
                        latestCandleTimeSec: 1_700_000_101,
                        feedLagSec: 1,
                    },
                    {
                        ...base,
                        recordType: "session_stop",
                        reason: "user_stop",
                        totalEntries: 0,
                        totalClosed: 0,
                        realizedPnlUsd: 0,
                    },
                ],
            });

            expect(response.statusCode).to.equal(200);
            const lines = readFileSync(logPath, "utf8").trim().split("\n");
            expect(lines).to.have.length(2);

            const afterStop = await invokePost(handler, "/log", {
                ...base,
                recordType: "session_stop",
                reason: "user_stop",
                totalEntries: 0,
                totalClosed: 0,
                realizedPnlUsd: 0,
            });
            expect(afterStop.statusCode).to.equal(404);
        } finally {
            rmSync(dirname(logPath), { recursive: true, force: true });
        }
    });

    it("rejects invalid batched log records before session lookup", async () => {
        const handler = createHandler();
        const response = await invokePost(handler, "/logs", {
            records: [{
                recordType: "paper_entry",
                sessionId: "missing-session",
                recordedAtIso: "2026-01-01T00:00:00.000Z",
                symbol: "BTCUSDT",
                interval: "1s",
                strategyKey: "test_strategy",
                tradeId: "trade-1",
                side: "yes",
                entryPrice: 0,
            }],
        });

        expect(response.statusCode).to.equal(400);
        expect(response.json.error).to.include("entryPrice");
    });

    it("requests quotes for backtest trade seconds missed by the latest quote", () => {
        const times = collectExecutionLabTradeQuoteTimes({
            backtestSettings: { executionModel: "next_open" },
            previousProcessedCandleTimeSec: 1_700_000_101,
            latestCandleTimeSec: 1_700_000_104,
            trades: [
                trade(1, 1_700_000_100, 1_700_000_103, "signal"),
                trade(2, 1_700_000_104, 1_700_000_109, "end_of_data"),
                trade(3, 1_700_000_099, 1_700_000_102, "time_stop"),
            ],
        });

        expect(times).to.deep.equal([1_700_000_102, 1_700_000_103, 1_700_000_104]);
    });

    it("requests shifted quote seconds for close-based paper execution fills", () => {
        const times = collectExecutionLabTradeQuoteTimes({
            backtestSettings: { executionModel: "signal_close" },
            previousProcessedCandleTimeSec: 1_700_000_100,
            latestCandleTimeSec: 1_700_000_104,
            trades: [
                trade(1, 1_700_000_101, 1_700_000_103, "signal"),
                trade(2, 1_700_000_104, 1_700_000_105, "signal"),
            ],
        });

        expect(times).to.deep.equal([1_700_000_102, 1_700_000_104]);
    });

    it("passes live CLOB quotes into Polymarket-1s helper strategy execution", async () => {
        const candles: OHLCVData[] = [
            { time: 1_700_000_100 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1 },
            { time: 1_700_000_101 as Time, open: 100, high: 102, low: 100, close: 101, volume: 1 },
            { time: 1_700_000_102 as Time, open: 101, high: 103, low: 101, close: 102, volume: 1 },
        ];
        const strategy: Strategy = {
            name: "Context Strategy",
            description: "Emits only when the caller-supplied live quote reaches the latest candle.",
            defaultParams: {},
            paramLabels: {},
            polymarket1sConfig: { required: true },
            execute(data, _params, context) {
                const last = data[data.length - 1];
                const latestTs = Number(last?.time);
                const hasLiveQuote = context?.polymarket1s?.quotes.some((quote) => quote.sample_ts === latestTs) === true;
                return last && hasLiveQuote
                    ? [{ time: last.time, type: "buy", price: last.close, barIndex: data.length - 1 }]
                    : [];
            },
        };

        const result = await executeBacktest({
            ohlcvData: candles,
            interval: "1s",
            primarySymbol: "BTCUSDT",
            strategyKey: "context_strategy",
            strategy,
            strategyParams: {},
            backtestSettings: { executionModel: "signal_close", tradeDirection: "long" },
            capitalSettings: { initialCapital: 10000, positionSize: 100, commission: 0, sizingMode: "percent", fixedTradeAmount: 0 },
            context: { nowSec: 1_700_000_104, blockRange: null, annotatePolymarket: false, engineMode: "typescript" },
            strategyExecutionContext: buildExecutionLabStrategyExecutionContext({
                snapshot: sessionSnapshot(),
                quotes: [clobQuote(1_700_000_102)],
            }),
            polymarket1sContextMode: "provided",
        });

        expect(result.signals).to.have.length(1);
        expect(result.result.trades).to.have.length(1);
    });

    it("classifies live fetch timeouts as transient poll errors", () => {
        expect(isExecutionLabTransientPollError(new Error("The operation was aborted due to timeout"))).to.equal(true);
        expect(isExecutionLabTransientPollError(new Error("Strategy changed. Stop and start a new Execution Lab session."))).to.equal(false);
    });
});

// Audit finding 3: malformed/oversized request bodies previously mapped to
// HTTP 500 (generic server error) because the outer handler catch was
// unconditional. The shared readJsonBody throws HttpStatusError with the
// correct 4xx status, which the catch now forwards verbatim.
describe("Execution Lab body parser status codes", () => {
    it("returns 400 for malformed JSON instead of 500", async () => {
        const handler = createHandler();
        const response = await invokePostRaw(handler, "/miner/start", "{not-json");
        expect(response.statusCode).to.equal(400);
        expect(response.json).to.deep.include({ ok: false, error: "Invalid JSON body." });
    });

    it("returns 413 when a declared Content-Length exceeds the 1 MiB cap", async () => {
        const handler = createHandler();
        // Declared content-length over the cap, empty stream — preflight rejects
        // before consuming the body (the old parser could not do this).
        const response = await invokePostRaw(handler, "/miner/start", "", {
            "content-length": String((1024 * 1024) + 1),
        });
        expect(response.statusCode).to.equal(413);
        expect(response.json.ok).to.equal(false);
        expect(String(response.json.error ?? "")).to.match(/too large/i);
    });

    it("returns 413 when a streaming body crosses the 1 MiB cap", async () => {
        const handler = createHandler();
        // Send a body just over 1 MiB. The shared parser rejects mid-stream.
        const over = Buffer.alloc((1024 * 1024) + 16, 0x61).toString("utf8");
        const response = await invokePostRaw(handler, "/miner/start", over);
        expect(response.statusCode).to.equal(413);
        expect(response.json.ok).to.equal(false);
    });

    it("returns 415 when a POST is not application/json (audit: content-type enforcement)", async () => {
        const handler = createHandler();
        // Override the default application/json with text/plain — must 415
        // before any JSON parsing or miner start side effect happens.
        const response = await invokePostRaw(
            handler,
            "/miner/start",
            JSON.stringify({ marketType: "spot" }),
            { "content-type": "text/plain" },
        );
        expect(response.statusCode).to.equal(415);
        expect(response.json.ok).to.equal(false);
        expect(String(response.json.error)).to.match(/application\/json/i);
    });
});

// Audit Finding: Execution Lab control-plane auth. Every POST plus GET
// /live/status must be gated by the shared loopback/bearer policy so a Vite
// server exposed via --host / tunnel / reverse proxy cannot be driven into
// spawning processes, writing files, or submitting/cancelling real orders.
describe("Execution Lab control-plane authorization", () => {
    const ORIGINAL_TOKEN = process.env.LOCAL_PROXY_TOKEN;

    beforeEach(() => {
        delete process.env.LOCAL_PROXY_TOKEN;
    });

    afterEach(() => {
        if (ORIGINAL_TOKEN === undefined) {
            delete process.env.LOCAL_PROXY_TOKEN;
        } else {
            process.env.LOCAL_PROXY_TOKEN = ORIGINAL_TOKEN;
        }
    });

    async function invokeWithHeaders(
        handler: MockHandler,
        method: string,
        path: string,
        headers: Record<string, string>,
        body?: unknown,
        socket: { remoteAddress?: string } | null = { remoteAddress: "127.0.0.1" },
    ): Promise<{ statusCode: number; json: any }> {
        return await new Promise((resolve, reject) => {
            const payload = body === undefined ? [] : [JSON.stringify(body)];
            const request = Readable.from(payload) as NodeJS.ReadableStream & {
                method?: string;
                url?: string;
                headers?: Record<string, string>;
                socket?: { remoteAddress?: string } | null;
            };
            request.method = method;
            request.url = path;
            request.headers = headers;
            request.socket = socket;
            const response = {
                statusCode: 200,
                setHeader() {},
                end(rawBody?: string) {
                    try {
                        resolve({ statusCode: response.statusCode, json: rawBody ? JSON.parse(rawBody) : null });
                    } catch (error) {
                        reject(error);
                    }
                },
            };
            Promise.resolve(handler(request, response)).catch(reject);
        });
    }

    it("allows a tokenless loopback POST when peer + Host + Origin are all loopback", async () => {
        const handler = createHandler();
        const response = await invokeWithHeaders(
            handler,
            "POST",
            "/session/start",
            { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173", "content-type": "application/json" },
            { strategyKey: "x", symbol: "BTCUSDT" },
            { remoteAddress: "127.0.0.1" },
        );
        // Auth passes (200/400 from validation, NOT 401 from auth).
        expect(response.statusCode).to.not.equal(401);
    });

    // ----- THE BYPASS THE OLD GATE HAD -----
    it("rejects a spoofed loopback Origin from a remote socket (the P1 bypass)", async () => {
        const handler = createHandler();
        const response = await invokeWithHeaders(
            handler,
            "POST",
            "/miner/stop",
            // Attacker on 192.0.2.10 forges Origin: http://127.0.0.1:5173.
            { host: "192.0.2.10:5173", origin: "http://127.0.0.1:5173", "content-type": "application/json" },
            undefined,
            { remoteAddress: "192.0.2.10" },
        );
        expect(response.statusCode).to.equal(401);
        expect(response.json.ok).to.equal(false);
        expect(String(response.json.error)).to.match(/local-only/i);
    });

    it("rejects a cross-origin POST from a loopback socket (CSRF defense)", async () => {
        const handler = createHandler();
        const response = await invokeWithHeaders(
            handler,
            "POST",
            "/session/start",
            { host: "127.0.0.1:5173", origin: "https://evil.test", "content-type": "application/json" },
            { strategyKey: "x", symbol: "BTCUSDT" },
            { remoteAddress: "127.0.0.1" },
        );
        expect(response.statusCode).to.equal(401);
    });

    it("rejects a remote POST with no Origin/Referer and no token", async () => {
        const handler = createHandler();
        const response = await invokeWithHeaders(
            handler,
            "POST",
            "/miner/stop",
            { host: "192.0.2.10:5173", "content-type": "application/json" },
            undefined,
            { remoteAddress: "192.0.2.10" },
        );
        expect(response.statusCode).to.equal(401);
    });

    it("accepts a remote POST presenting the configured LOCAL_PROXY_TOKEN bearer", async () => {
        process.env.LOCAL_PROXY_TOKEN = "execution-lab-secret";
        try {
            const handler = createHandler();
            const response = await invokeWithHeaders(
                handler,
                "POST",
                "/miner/stop",
                {
                    host: "tunnel.example.test:5173",
                    origin: "https://evil.test",
                    "content-type": "application/json",
                    authorization: "Bearer execution-lab-secret",
                },
                undefined,
                { remoteAddress: "192.0.2.10" },
            );
            // Auth passes (200 from stopMiner), NOT 401.
            expect(response.statusCode).to.not.equal(401);
        } finally {
            delete process.env.LOCAL_PROXY_TOKEN;
        }
    });

    it("gates GET /live/status (executor config probe) but allows read-only /miner/status", async () => {
        const handler = createHandler();
        const remoteSocket = { remoteAddress: "192.0.2.10" };
        const remoteHeaders = { host: "192.0.2.10:5173", origin: "https://evil.test" };

        const liveStatus = await invokeWithHeaders(handler, "GET", "/live/status", remoteHeaders, undefined, remoteSocket);
        expect(liveStatus.statusCode).to.equal(401);

        const minerStatus = await invokeWithHeaders(handler, "GET", "/miner/status", remoteHeaders, undefined, remoteSocket);
        // Read-only miner status is NOT under the gate.
        expect(minerStatus.statusCode).to.equal(200);
    });
});

// Audit Finding: abandoned Execution Lab session expiry. Sessions were
// previously removed only when a valid session_stop record arrived, so a
// browser crash / reload / network error / malicious session creation left
// entries — and the session IDs accepted by live-trade validation — alive
// indefinitely. These tests verify the lifecycle that TTL pruning builds on:
// a stopped session is dropped immediately, and the live-trade handler then
// rejects its sessionId.
describe("Execution Lab session lifecycle (TTL pruning foundation)", () => {
    beforeEach(() => {
        const tmp = mkdtempSync(join(tmpdir(), "exec-lab-session-"));
        __setLogRootForTests(tmp);
    });

    afterEach(() => {
        __setLogRootForTests(null);
    });

    async function invokeWithHeaders(
        handler: MockHandler,
        method: string,
        path: string,
        headers: Record<string, string>,
        body?: unknown,
    ): Promise<{ statusCode: number; json: any }> {
        return await new Promise((resolve, reject) => {
            const payload = body === undefined ? [] : [JSON.stringify(body)];
            const request = Readable.from(payload) as NodeJS.ReadableStream & {
                method?: string;
                url?: string;
                headers?: Record<string, string>;
                socket?: { remoteAddress?: string } | null;
            };
            request.method = method;
            request.url = path;
            request.headers = headers;
            request.socket = LOOPBACK_SOCKET;
            const response = {
                statusCode: 200,
                setHeader() {},
                end(rawBody?: string) {
                    try {
                        resolve({ statusCode: response.statusCode, json: rawBody ? JSON.parse(rawBody) : null });
                    } catch (error) {
                        reject(error);
                    }
                },
            };
            Promise.resolve(handler(request, response)).catch(reject);
        });
    }

    it("drops a session after a session_stop record and rejects its sessionId on live trade", async () => {
        const handler = createDevHandler();
        const loopback = { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173", "content-type": "application/json" };

        const start = await invokeWithHeaders(
            handler,
            "POST",
            "/session/start",
            loopback,
            { strategyKey: "demo_strategy", symbol: "BTCUSDT" },
        );
        expect(start.statusCode).to.equal(200);
        const sessionId: string = start.json.sessionId;
        expect(sessionId).to.be.a("string");

        // Session is recognized while alive — live trade reaches validation,
        // not the 404 "Unknown execution lab session" branch.
        const liveTradeBefore = await invokeWithHeaders(
            handler,
            "POST",
            "/live/trade",
            loopback,
            { sessionId },
        );
        expect(liveTradeBefore.statusCode).to.not.equal(404);

        // Send session_stop, which removes the session synchronously.
        const stop = await invokeWithHeaders(
            handler,
            "POST",
            "/logs",
            loopback,
            {
                records: [
                    {
                        recordType: "session_stop",
                        sessionId,
                        symbol: "BTCUSDT",
                        interval: "1s",
                        strategyKey: "demo_strategy",
                        recordedAtIso: new Date().toISOString(),
                        reason: "user_stop",
                    },
                ],
            },
        );
        expect(stop.statusCode).to.equal(200);

        // Session is now gone — live trade must 404.
        const liveTradeAfter = await invokeWithHeaders(
            handler,
            "POST",
            "/live/trade",
            loopback,
            { sessionId },
        );
        expect(liveTradeAfter.statusCode).to.equal(404);
        expect(String(liveTradeAfter.json.error)).to.match(/unknown execution lab session/i);
    });

    it("prunes a session after the 6-hour idle TTL even with no session_stop", async () => {
        // Real TTL test: stub Date.now so the next request appears to arrive
        // > SESSION_IDLE_TTL_MS after the session was created, then verify the
        // session is rejected as Unknown on /live/trade. This fails if the
        // pruning call, comparison direction, or TTL constant changes.
        const handler = createDevHandler();
        const loopback = { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173", "content-type": "application/json" };

        const start = await invokeWithHeaders(
            handler,
            "POST",
            "/session/start",
            loopback,
            { strategyKey: "demo_strategy", symbol: "BTCUSDT" },
        );
        expect(start.statusCode).to.equal(200);
        const sessionId: string = start.json.sessionId;
        expect(sessionId).to.be.a("string");

        // Sanity: while fresh, /live/trade recognizes the session.
        const liveTradeFresh = await invokeWithHeaders(
            handler,
            "POST",
            "/live/trade",
            loopback,
            { sessionId },
        );
        expect(liveTradeFresh.statusCode).to.not.equal(404);

        // Advance Date.now beyond the 6-hour idle TTL. `pruneExpiredSessions`
        // runs on /live/trade before the session lookup, so the now-expired
        // session is dropped before validation reaches it.
        const SESSION_IDLE_TTL_MS = 6 * 60 * 60 * 1000;
        const realDateNow = Date.now;
        const baseMs = realDateNow.call(Date);
        try {
            Date.now = () => baseMs + SESSION_IDLE_TTL_MS + 1;
            const liveTradeAged = await invokeWithHeaders(
                handler,
                "POST",
                "/live/trade",
                loopback,
                { sessionId },
            );
            expect(liveTradeAged.statusCode).to.equal(404);
            expect(String(liveTradeAged.json.error)).to.match(/unknown execution lab session/i);

            // Likewise /logs must reject an aged session — pruneExpiredSessions
            // also runs on log append.
            const logAged = await invokeWithHeaders(
                handler,
                "POST",
                "/logs",
                loopback,
                {
                    records: [
                        {
                            recordType: "session_start",
                            sessionId,
                            symbol: "BTCUSDT",
                            interval: "1s",
                            strategyKey: "demo_strategy",
                            recordedAtIso: new Date(baseMs + SESSION_IDLE_TTL_MS + 1).toISOString(),
                            stakeUsd: 5,
                        },
                    ],
                },
            );
            expect(logAged.statusCode).to.equal(404);
        } finally {
            Date.now = realDateNow;
        }
    });
});

