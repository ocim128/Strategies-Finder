import { expect } from "chai";
import { describe, it } from "node:test";
import { Readable } from "node:stream";
import { dirname } from "node:path";
import { readFileSync, rmSync } from "node:fs";
import { executeBacktest } from "../lib/backtest-executor";
import { buildExecutionLabStrategyExecutionContext } from "../lib/execution-lab/execution-lab-strategy-context";
import { executionLabVitePlugin, normalizeExecutionLabClobPrice } from "../lib/execution-lab/execution-lab-vite-plugin";
import type { ExecutionLabSessionSnapshot } from "../lib/execution-lab/execution-lab-model";
import { isExecutionLabTransientPollError } from "../lib/execution-lab/poll-errors";
import { collectExecutionLabTradeQuoteTimes } from "../lib/execution-lab/trade-quote-times";
import type { PolymarketClob1sQuoteRow } from "../lib/second-market/types";
import type { OHLCVData, Strategy, Time, Trade } from "../lib/types/strategies";

type MockHandler = (req: NodeJS.ReadableStream & { method?: string; url?: string }, res: {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body?: string): void;
}) => void | Promise<void>;

function createHandler(): MockHandler {
    let handler: MockHandler | null = null;
    const plugin = executionLabVitePlugin();
    plugin.configurePreviewServer?.({
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
        const request = Readable.from([]) as NodeJS.ReadableStream & { method?: string; url?: string };
        request.method = "GET";
        request.url = path;
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
        const request = Readable.from([JSON.stringify(body)]) as NodeJS.ReadableStream & { method?: string; url?: string };
        request.method = "POST";
        request.url = path;
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

function trade(id: number, entryTime: number, exitTime: number, exitReason: Trade["exitReason"]): Trade {
    return {
        id,
        type: "long",
        entryTime,
        entryPrice: 100,
        exitTime,
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
            expect(requestedUrl?.searchParams.get("end_date_min")).to.not.equal(null);
            expect(requestedUrl?.searchParams.get("start_date_min")).to.equal(null);
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

    it("reports idle miner status without starting a process", async () => {
        const handler = createHandler();
        const response = await invoke(handler, "/miner/status");

        expect(response.statusCode).to.equal(200);
        expect(response.json.running).to.equal(false);
        expect(response.json.dbPath).to.include("second-market-data.sqlite");
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
