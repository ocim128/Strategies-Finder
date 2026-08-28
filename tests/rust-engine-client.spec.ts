import { expect } from "chai";
import { describe, it } from "node:test";
import { packMultiAssetSignals, RustEngineClient } from "../lib/rust-engine-client";
import type { BacktestSettings, OHLCVData, Signal, Time } from "../lib/types/strategies";

const data: OHLCVData[] = [{
    time: 1 as Time,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1_000,
}];
const settings: BacktestSettings = { executionModel: "signal_close" };

function emptyBacktestResponse(): Record<string, unknown> {
    return {
        trades: [],
        netProfit: 0,
        netProfitPercent: 0,
        winRate: 0,
        expectancy: 0,
        avgTrade: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
    };
}

function createClient(capture: (body: Record<string, unknown>) => void): RustEngineClient {
    const fetchImpl: typeof fetch = async (url, init) => {
        if (String(url).endsWith("/api/health")) {
            return new Response(JSON.stringify({
                status: "healthy",
                engine: "trading-engine-rust",
                version: "0.1.0",
            }), { status: 200 });
        }
        capture(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify(emptyBacktestResponse()), { status: 200 });
    };
    return new RustEngineClient("http://127.0.0.1:3030", fetchImpl);
}

describe("Rust generic backtest output options", () => {
    it("sends compact and trade-history options to the generic endpoint", async () => {
        let requestBody: Record<string, unknown> | undefined;
        const client = createClient((body) => { requestBody = body; });

        await client.runBacktest(
            data,
            [],
            10_000,
            100,
            0.1,
            settings,
            undefined,
            { compact: true, retainTrades: true },
        );

        expect(requestBody?.compact).to.equal(true);
        expect(requestBody?.retainTrades).to.equal(true);
    });

    it("keeps full-output defaults for callers without options", async () => {
        let requestBody: Record<string, unknown> | undefined;
        const client = createClient((body) => { requestBody = body; });

        await client.runBacktest(data, [], 10_000, 100, 0.1, settings);

        expect(requestBody?.compact).to.equal(false);
        expect(requestBody?.retainTrades).to.equal(false);
    });

    it("rejects malformed generic results before they reach the executor", async () => {
        const fetchImpl: typeof fetch = async (url) => {
            if (String(url).endsWith("/api/health")) {
                return new Response(JSON.stringify({
                    status: "healthy",
                    engine: "trading-engine-rust",
                }), { status: 200 });
            }
            const malformed = emptyBacktestResponse();
            delete malformed.equityCurve;
            return new Response(JSON.stringify(malformed), { status: 200 });
        };
        const client = new RustEngineClient("http://127.0.0.1:3030", fetchImpl);

        const result = await client.runBacktest(data, [], 10_000, 100, 0.1, settings);

        expect(result).to.equal(null);
    });

    it("hashes every candle so an unsampled mutation cannot reuse a cache key", () => {
        const largeData: OHLCVData[] = Array.from({ length: 400_001 }, (_, index) => ({
            time: index as Time,
            open: 100,
            high: 101,
            low: 99,
            close: 100,
            volume: 1_000,
        }));
        const client = new RustEngineClient("http://127.0.0.1:3030", async () => new Response());
        const before = client.getDataCacheKey(largeData);

        largeData[1]!.close = 100.25;

        expect(client.getDataCacheKey(largeData)).to.not.equal(before);
    });

    it("shares one uncancellable health probe and verifies the engine identity", async () => {
        let healthCalls = 0;
        const fetchImpl: typeof fetch = async (url) => {
            if (!String(url).endsWith("/api/health")) return new Response("{}", { status: 404 });
            healthCalls += 1;
            await new Promise((resolve) => setTimeout(resolve, 10));
            return new Response(JSON.stringify({
                status: "healthy",
                engine: "trading-engine-rust",
                version: "0.1.0",
            }), { status: 200 });
        };
        const client = new RustEngineClient("http://127.0.0.1:3030", fetchImpl);

        const results = await Promise.all(Array.from({ length: 8 }, () => client.checkHealth()));

        expect(results).to.deep.equal(Array.from({ length: 8 }, () => true));
        expect(healthCalls).to.equal(1);

        const wrongEngine = new RustEngineClient("http://127.0.0.1:3030", async () => new Response(
            JSON.stringify({ status: "healthy", engine: "not-trading-engine-rust" }),
            { status: 200 },
        ));
        expect(await wrongEngine.checkHealth()).to.equal(false);
        expect(wrongEngine.healthDiagnostics.failureReason).to.equal("invalid_engine:not-trading-engine-rust");
    });

    it("caches protocol capabilities and treats malformed capability payloads as unsupported", async () => {
        const client = new RustEngineClient("http://127.0.0.1:3030", async (url) => {
            if (!String(url).endsWith("/api/health")) return new Response("{}", { status: 404 });
            return new Response(JSON.stringify({
                status: "healthy",
                engine: "trading-engine-rust",
                protocolVersion: 2,
                buildProfile: "release",
                capabilities: {
                    "backtest.next_open.v1": true,
                    "backtest.exit_reason.v1": false,
                    bad: "true",
                },
            }), { status: 200 });
        });

        expect(await client.checkHealth()).to.equal(true);
        expect(client.protocolVersion).to.equal(2);
        expect(client.buildProfile).to.equal("release");
        expect(client.supportsCapabilities(["backtest.next_open.v1"])).to.equal(true);
        expect(client.supportsCapabilities(["backtest.exit_reason.v1"])).to.equal(false);
        expect(client.supportsCapabilities(["bad"])).to.equal(false);
    });

    it("parses debug and release build profiles while preserving legacy missing metadata", async () => {
        for (const buildProfile of ["debug", "release"] as const) {
            const client = new RustEngineClient("http://127.0.0.1:3030", async (url) => {
                if (!String(url).endsWith("/api/health")) return new Response("{}", { status: 404 });
                return new Response(JSON.stringify({
                    status: "healthy",
                    engine: "trading-engine-rust",
                    protocolVersion: 2,
                    buildProfile,
                    capabilities: {
                        "backtest.next_open.v1": true,
                        "backtest.risk_max_hold.v1": true,
                        "backtest.exit_reason.v1": true,
                    },
                }), { status: 200 });
            });

            expect(await client.checkHealth()).to.equal(true);
            expect(client.buildProfile).to.equal(buildProfile);
            expect(client.protocolVersion).to.equal(2);
            expect([...client.capabilities]).to.deep.equal([
                "backtest.next_open.v1",
                "backtest.risk_max_hold.v1",
                "backtest.exit_reason.v1",
            ]);
        }

        const legacy = new RustEngineClient("http://127.0.0.1:3030", async (url) => {
            if (!String(url).endsWith("/api/health")) return new Response("{}", { status: 404 });
            return new Response(JSON.stringify({
                status: "healthy",
                engine: "trading-engine-rust",
                protocolVersion: 2,
                capabilities: {},
            }), { status: 200 });
        });
        expect(await legacy.checkHealth()).to.equal(true);
        expect(legacy.buildProfile).to.equal(null);
    });

    it("rejects a protocol-v2 generic trade that omits its authoritative exit reason", async () => {
        const malformed = emptyBacktestResponse();
        malformed.trades = [{
            id: 0,
            type: "long",
            entryTime: 1,
            entryPrice: 100,
            exitTime: 1,
            exitPrice: 100,
            pnl: 0,
            pnlPercent: 0,
            size: 1,
        }];
        malformed.totalTrades = 1;
        malformed.losingTrades = 1;
        const client = new RustEngineClient("http://127.0.0.1:3030", async (url) => {
            if (String(url).endsWith("/api/health")) {
                return new Response(JSON.stringify({
                    status: "healthy",
                    engine: "trading-engine-rust",
                    protocolVersion: 2,
                    capabilities: {},
                }), { status: 200 });
            }
            return new Response(JSON.stringify(malformed), { status: 200 });
        });

        const result = await client.runBacktest(data, [], 10_000, 100, 0.1, settings);
        expect(result).to.equal(null);
    });

    it("returns cancellation distinctly so callers do not silently retry in TypeScript", async () => {
        const controller = new AbortController();
        controller.abort();
        const client = new RustEngineClient("http://127.0.0.1:3030", async () => {
            throw new Error("fetch should not run after cancellation");
        });
        const result = await client.runBacktestWithStatus(
            data,
            [],
            10_000,
            100,
            0.1,
            settings,
            undefined,
            undefined,
            { signal: controller.signal },
        );
        expect(result).to.deep.include({ ok: false, reason: "cancelled" });
    });

    it("rejects behavior-bearing Polymarket exit reasons before any Rust request or packing", async () => {
        let transportCalls = 0;
        const client = createClient(() => { transportCalls += 1; });
        for (const reason of ["polymarket_take_profit", "polymarket_stop_loss"] as const) {
            const signal: Signal = { time: 1 as Time, type: "sell", price: 100, reason };
            const result = await client.runBacktestWithStatus(
                data,
                [signal],
                10_000,
                100,
                0.1,
                settings,
            );
            expect(result).to.deep.include({ ok: false, reason: "unsupported_signal_shape" });
            expect(packMultiAssetSignals([signal])).to.equal(null);
        }
        expect(transportCalls).to.equal(0);
    });

    it("rejects behavior-bearing reasons at every batch endpoint boundary", async () => {
        let transportCalls = 0;
        const client = createClient(() => { transportCalls += 1; });
        const signal: Signal = {
            time: 1 as Time,
            type: "sell",
            price: 100,
            reason: "polymarket_stop_loss",
        };
        const items = [{ id: "behavior", signals: [signal] }];
        const workload = [{ id: "workload", items }];
        const results = await Promise.all([
            client.runBatchBacktestWithStatus(data, items, 10_000, 100, 0.1, settings, undefined, false),
            client.runCachedBatchBacktestWithStatus("cache", items, 10_000, 100, 0.1, settings, undefined, false),
            client.runFreshEntryBatchBacktestWithStatus(data, items, 10_000, 100, 0.1, settings),
            client.runCachedFreshEntryBatchBacktestWithStatus("cache", items, 10_000, 100, 0.1, settings),
            client.runAssetOpportunityBatchBacktestWithStatus(data, items, 10_000, 100, 0.1, settings, data[0]!.time),
            client.runCachedAssetOpportunityBatchBacktestWithStatus("cache", items, 10_000, 100, 0.1, settings, data[0]!.time),
            client.runMultiAssetAssetOpportunityBatchBacktestWithStatus(workload, 10_000, 100, 0.1, settings),
            client.runMultiAssetFreshEntryBatchBacktestWithStatus(workload, 10_000, 100, 0.1, settings),
        ]);

        for (const result of results) {
            expect(result).to.deep.include({ ok: false, reason: "unsupported_signal_shape" });
        }
        expect(transportCalls).to.equal(0);
    });

    it("gives cancellation precedence over unsupported batch signal shapes", async () => {
        const controller = new AbortController();
        controller.abort();
        const client = createClient(() => {
            throw new Error("cancelled batch must not reach transport");
        });
        const result = await client.runBatchBacktestWithStatus(
            data,
            [{
                id: "cancelled-behavior",
                signals: [{
                    time: 1 as Time,
                    type: "sell",
                    price: 100,
                    reason: "polymarket_stop_loss",
                }],
            }],
            10_000,
            100,
            0.1,
            settings,
            undefined,
            false,
            { signal: controller.signal },
        );

        expect(result).to.deep.include({ ok: false, reason: "cancelled" });
    });

    it("aborts a generic health probe without converting it into a fallback request", async () => {
        const controller = new AbortController();
        let healthCalls = 0;
        const client = new RustEngineClient("http://127.0.0.1:3030", async (url, init) => {
            if (!String(url).endsWith("/api/health")) {
                throw new Error("backtest request must not start after health cancellation");
            }
            healthCalls += 1;
            return await new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => {
                    reject(new DOMException("aborted", "AbortError"));
                }, { once: true });
            });
        });

        const pending = client.runBacktestWithStatus(
            data,
            [],
            10_000,
            100,
            0.1,
            settings,
            undefined,
            undefined,
            { signal: controller.signal },
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        controller.abort();

        const result = await pending;
        expect(result).to.deep.include({ ok: false, reason: "cancelled" });
        expect(healthCalls).to.equal(1);
    });

    it("aborts an in-flight generic backtest request and preserves the cancellation reason", async () => {
        const controller = new AbortController();
        const client = new RustEngineClient("http://127.0.0.1:3030", async (url, init) => {
            if (String(url).endsWith("/api/health")) {
                return new Response(JSON.stringify({
                    status: "healthy",
                    engine: "trading-engine-rust",
                    protocolVersion: 2,
                    capabilities: {},
                }), { status: 200 });
            }
            return await new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => {
                    reject(new DOMException("aborted", "AbortError"));
                }, { once: true });
            });
        });

        const pending = client.runBacktestWithStatus(
            data,
            [],
            10_000,
            100,
            0.1,
            settings,
            undefined,
            undefined,
            { signal: controller.signal },
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        controller.abort();

        const result = await pending;
        expect(result).to.deep.include({ ok: false, reason: "cancelled" });
    });

    it("does not accept a generic response when cancellation arrives during decoding", async () => {
        const controller = new AbortController();
        const client = new RustEngineClient("http://127.0.0.1:3030", async (url) => {
            if (String(url).endsWith("/api/health")) {
                return new Response(JSON.stringify({
                    status: "healthy",
                    engine: "trading-engine-rust",
                }), { status: 200 });
            }
            const response = new Response(JSON.stringify(emptyBacktestResponse()), { status: 200 });
            Object.defineProperty(response, "json", {
                value: async () => {
                    controller.abort();
                    return emptyBacktestResponse();
                },
            });
            return response;
        });

        const result = await client.runBacktestWithStatus(
            data,
            [],
            10_000,
            100,
            0.1,
            settings,
            undefined,
            undefined,
            { signal: controller.signal },
        );

        expect(result).to.deep.include({ ok: false, reason: "cancelled" });
    });

    it("does not accept a batch response when cancellation arrives during decoding", async () => {
        const controller = new AbortController();
        const client = new RustEngineClient("http://127.0.0.1:3030", async (url) => {
            if (String(url).endsWith("/api/health")) {
                return new Response(JSON.stringify({
                    status: "healthy",
                    engine: "trading-engine-rust",
                }), { status: 200 });
            }
            const response = new Response("{}", { status: 200 });
            Object.defineProperty(response, "text", {
                value: async () => {
                    controller.abort();
                    return JSON.stringify({ results: [], processingTimeMs: 0 });
                },
            });
            return response;
        });

        const result = await client.runBatchBacktestWithStatus(
            data,
            [{ id: "candidate", signals: [] }],
            10_000,
            100,
            0.1,
            settings,
            undefined,
            true,
            { signal: controller.signal },
        );

        expect(result).to.deep.include({ ok: false, reason: "cancelled" });
    });
});
