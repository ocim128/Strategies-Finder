import { expect } from "chai";
import { describe, it } from "node:test";
import { RustEngineClient } from "../lib/rust-engine-client";
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

        await client.runBacktestWithStatus(
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

        await client.runBacktestWithStatus(data, [], 10_000, 100, 0.1, settings);

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

        const result = await client.runBacktestWithStatus(data, [], 10_000, 100, 0.1, settings);

        expect(result).to.deep.include({ ok: false, reason: "malformed_response" });
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

        const result = await client.runBacktestWithStatus(data, [], 10_000, 100, 0.1, settings);
        expect(result).to.deep.include({ ok: false, reason: "malformed_response" });
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

    it("rejects behavior-bearing reasons at every generic batch endpoint boundary", async () => {
        let transportCalls = 0;
        const client = createClient(() => { transportCalls += 1; });
        const signal: Signal = {
            time: 1 as Time,
            type: "sell",
            price: 100,
            reason: "legacy_reason" as Signal["reason"],
        };
        const items = [{ id: "behavior", signals: [signal] }];
        const results = await Promise.all([
            client.runBatchBacktestWithStatus(data, items, 10_000, 100, 0.1, settings, undefined, false),
            client.runCachedBatchBacktestWithStatus("cache", items, 10_000, 100, 0.1, settings, undefined, false),
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
                    reason: "legacy_reason" as Signal["reason"],
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
            Object.defineProperty(response, "text", {
                value: async () => {
                    controller.abort();
                    return JSON.stringify(emptyBacktestResponse());
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

describe("Rust single-run transport budgets", () => {
    function healthyFetch(transport: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
        return (async (url: RequestInfo | URL, init?: RequestInit) => {
            if (String(url).endsWith("/api/health")) {
                return new Response(JSON.stringify({
                    status: "healthy",
                    engine: "trading-engine-rust",
                    protocolVersion: 2,
                    capabilities: {},
                }), { status: 200 });
            }
            return transport(String(url), init);
        }) as typeof fetch;
    }

    it("accepts a request at exactly the byte limit and counts encoded bytes, not characters", async () => {
        let postedBytes: number | undefined;
        const client = new RustEngineClient("http://127.0.0.1:3030", healthyFetch(async (_url, init) => {
            const body = String(init?.body);
            postedBytes = new TextEncoder().encode(body).byteLength;
            return new Response(JSON.stringify(emptyBacktestResponse()), { status: 200 });
        }));

        // A multibyte exit key makes the JS string length diverge from the
        // encoded byte length; the limit is byte-exact.
        const multibyteSettings: BacktestSettings = { ...settings, exitStrategyKey: "ΩΩΩΩΩΩΩΩ" };
        const requestBytes = new TextEncoder().encode(JSON.stringify({
            data,
            signals: [],
            initialCapital: 10_000,
            positionSizePercent: 100,
            commissionPercent: 0.1,
            settings: multibyteSettings,
            sizing: undefined,
            compact: false,
            retainTrades: false,
        })).byteLength;

        const atLimit = await client.runBacktestWithStatus(
            data, [], 10_000, 100, 0.1, multibyteSettings, undefined, undefined,
            { maxRequestBytes: requestBytes },
        );
        expect(atLimit.ok, JSON.stringify(atLimit)).to.equal(true);
        expect(postedBytes).to.be.greaterThan(requestBytes - 10);

        const overLimit = await client.runBacktestWithStatus(
            data, [], 10_000, 100, 0.1, multibyteSettings, undefined, undefined,
            { maxRequestBytes: requestBytes - 1 },
        );
        expect(overLimit).to.deep.include({ ok: false, reason: "request_too_large" });
    });

    it("rejects oversized requests before POST", async () => {
        let transportCalls = 0;
        const client = new RustEngineClient("http://127.0.0.1:3030", healthyFetch(async () => {
            transportCalls += 1;
            return new Response(JSON.stringify(emptyBacktestResponse()), { status: 200 });
        }));

        const result = await client.runBacktestWithStatus(
            data, [], 10_000, 100, 0.1, settings, undefined, undefined,
            { maxRequestBytes: 4 },
        );

        expect(result).to.deep.include({ ok: false, reason: "request_too_large" });
        expect(transportCalls).to.equal(0);
    });

    it("rejects a response whose declared content length exceeds the limit without reading the body", async () => {
        let pulls = 0;
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulls += 1;
                controller.enqueue(new TextEncoder().encode(JSON.stringify(emptyBacktestResponse())));
                controller.close();
            },
            cancel() {
                cancelled = true;
            },
        });
        const client = new RustEngineClient("http://127.0.0.1:3030", healthyFetch(async () => {
            const response = new Response(body, { status: 200 });
            Object.defineProperty(response, "headers", {
                value: new Headers({ "content-length": String(10_000_000) }),
            });
            return response;
        }));

        const result = await client.runBacktestWithStatus(
            data, [], 10_000, 100, 0.1, settings, undefined, undefined,
            { maxResponseBytes: 128 },
        );

        expect(result).to.deep.include({ ok: false, reason: "response_too_large" });
        // The early header rejection cancels the unread body so the transport
        // resource is released instead of streaming to a dead reader.
        expect(cancelled, "unread body must be cancelled").to.equal(true);
        expect(pulls).to.be.lessThan(2);
    });

    it("cancels a chunked body that exceeds the streamed byte limit", async () => {
        let cancelled = false;
        const encoder = new TextEncoder();
        const full = JSON.stringify(emptyBacktestResponse());
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                for (const chunk of [full.slice(0, 100), full.slice(100, 200), full.slice(200)]) {
                    controller.enqueue(encoder.encode(chunk));
                }
                controller.close();
            },
            cancel() {
                cancelled = true;
            },
        });
        const client = new RustEngineClient("http://127.0.0.1:3030", healthyFetch(async () => new Response(body, { status: 200 })));

        const result = await client.runBacktestWithStatus(
            data, [], 10_000, 100, 0.1, settings, undefined, undefined,
            { maxResponseBytes: 64 },
        );

        expect(result).to.deep.include({ ok: false, reason: "response_too_large" });
        expect(cancelled, "stream reader must cancel the oversized body").to.equal(true);
    });

    it("accepts a chunked response within the limit even with a missing content length", async () => {
        const encoder = new TextEncoder();
        const full = JSON.stringify(emptyBacktestResponse());
        const chunks = [encoder.encode(full.slice(0, 50)), encoder.encode(full.slice(50))];
        const client = new RustEngineClient("http://127.0.0.1:3030", healthyFetch(async () => {
            const response = new Response(new Blob(chunks), { status: 200 });
            // Strip the auto content-length so the streamed path alone decides.
            Object.defineProperty(response, "headers", { value: new Headers() });
            return response;
        }));

        const result = await client.runBacktestWithStatus(
            data, [], 10_000, 100, 0.1, settings, undefined, undefined,
            { maxResponseBytes: 4_096 },
        );

        expect(result.ok, JSON.stringify(result)).to.equal(true);
    });

    it("returns malformed_response for unparseable JSON", async () => {
        const client = new RustEngineClient("http://127.0.0.1:3030", healthyFetch(async () => new Response("{not json", { status: 200 })));

        const result = await client.runBacktestWithStatus(data, [], 10_000, 100, 0.1, settings);

        expect(result).to.deep.include({ ok: false, reason: "malformed_response" });
    });

    it("honors a timeout override below the 30-second single-run default", async () => {
        const client = new RustEngineClient("http://127.0.0.1:3030", healthyFetch(async (_url, init) => {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(resolve, 5_000);
                init?.signal?.addEventListener("abort", () => {
                    clearTimeout(timer);
                    reject(new DOMException("timed out", "TimeoutError"));
                }, { once: true });
            });
            return new Response(JSON.stringify(emptyBacktestResponse()), { status: 200 });
        }));

        const startedAt = Date.now();
        const result = await client.runBacktestWithStatus(
            data, [], 10_000, 100, 0.1, settings, undefined, undefined,
            { timeoutMs: 25 },
        );

        expect(result).to.deep.include({ ok: false, reason: "timeout" });
        expect(Date.now() - startedAt).to.be.lessThan(2_000);
    });

    it("gives caller cancellation precedence over size limits at every stage", async () => {
        const controller = new AbortController();
        controller.abort();
        const client = new RustEngineClient("http://127.0.0.1:3030", healthyFetch(async () => {
            throw new Error("cancelled single run must not reach transport");
        }));

        const result = await client.runBacktestWithStatus(
            data, [], 10_000, 100, 0.1, settings, undefined, undefined,
            { signal: controller.signal, maxRequestBytes: 4 },
        );

        expect(result).to.deep.include({ ok: false, reason: "cancelled" });
    });

    it("reads unlimited responses directly and keeps bounded responses off the text path", async () => {
        let textCalls = 0;
        const trackedResponse = (): Response => {
            const response = new Response(JSON.stringify(emptyBacktestResponse()), { status: 200 });
            const originalText = response.text.bind(response);
            response.text = async () => {
                textCalls += 1;
                return originalText();
            };
            return response;
        };
        const client = new RustEngineClient("http://127.0.0.1:3030", healthyFetch(async () => trackedResponse()));

        // Unlimited: the client reads and parses the text directly.
        const unlimited = await client.runBacktestWithStatus(data, [], 10_000, 100, 0.1, settings);
        expect(unlimited.ok, JSON.stringify(unlimited)).to.equal(true);
        expect(textCalls).to.equal(1);

        // Bounded: the budget is enforced by the streamed reader path, so the
        // client never takes the whole-body text shortcut.
        const bounded = await client.runBacktestWithStatus(
            data, [], 10_000, 100, 0.1, settings, undefined, undefined,
            { maxResponseBytes: 4_096 },
        );
        expect(bounded.ok, JSON.stringify(bounded)).to.equal(true);
        expect(textCalls).to.equal(1);
    });
});

describe("Rust single-run result acceptance", () => {
    function v2Trade(): Record<string, unknown> {
        return {
            id: 0,
            type: "long",
            entryTime: 1,
            entryPrice: 100,
            exitTime: 1,
            exitPrice: 100,
            pnl: 0,
            pnlPercent: 0,
            size: 1,
            exitReason: "signal",
        };
    }

    function tradeResponse(overrides: {
        trades?: unknown[];
        totalTrades: number;
        winningTrades: number;
        losingTrades: number;
        netProfit?: number;
        winRate?: number;
        avgTrade?: number;
        profitFactor?: number | null;
    }): Record<string, unknown> {
        const response = emptyBacktestResponse();
        response.trades = overrides.trades ?? [];
        response.totalTrades = overrides.totalTrades;
        response.winningTrades = overrides.winningTrades;
        response.losingTrades = overrides.losingTrades;
        if (overrides.netProfit !== undefined) response.netProfit = overrides.netProfit;
        if (overrides.winRate !== undefined) response.winRate = overrides.winRate;
        if (overrides.avgTrade !== undefined) response.avgTrade = overrides.avgTrade;
        if (overrides.profitFactor !== undefined) response.profitFactor = overrides.profitFactor;
        return response;
    }

    function acceptanceClient(body: Record<string, unknown>): RustEngineClient {
        const fetchImpl: typeof fetch = async (url) => {
            if (String(url).endsWith("/api/health")) {
                return new Response(JSON.stringify({
                    status: "healthy",
                    engine: "trading-engine-rust",
                    protocolVersion: 2,
                    capabilities: {},
                }), { status: 200 });
            }
            return new Response(JSON.stringify(body), { status: 200 });
        };
        return new RustEngineClient("http://127.0.0.1:3030", fetchImpl);
    }

    it("rejects trade counts that do not reconcile", async () => {
        const client = acceptanceClient(tradeResponse({
            totalTrades: 2,
            winningTrades: 1,
            losingTrades: 0,
        }));

        const result = await client.runBacktestWithStatus(data, [], 10_000, 100, 0.1, settings);

        expect(result).to.deep.include({ ok: false, reason: "malformed_response" });
    });

    it("accepts winRate at the one-point tolerance edge and rejects beyond it", async () => {
        const counts = { totalTrades: 10, winningTrades: 5, losingTrades: 5 };
        const trades = [v2Trade(), v2Trade(), v2Trade(), v2Trade(), v2Trade()];
        // 5/10 winners means an expected win rate of exactly 50; one point
        // of drift is tolerated, anything beyond is rejected.
        const atEdge = acceptanceClient(tradeResponse({
            ...counts,
            trades,
            netProfit: 100,
            winRate: 51,
            avgTrade: 10,
            profitFactor: 1,
        }));
        const atEdgeResult = await atEdge.runBacktestWithStatus(data, [], 10_000, 100, 0.1, settings);
        expect(atEdgeResult.ok, JSON.stringify(atEdgeResult)).to.equal(true);

        const beyond = acceptanceClient(tradeResponse({
            ...counts,
            trades,
            netProfit: 100,
            winRate: 51.2,
            avgTrade: 10,
            profitFactor: 1,
        }));
        const beyondResult = await beyond.runBacktestWithStatus(data, [], 10_000, 100, 0.1, settings);
        expect(beyondResult).to.deep.include({ ok: false, reason: "malformed_response" });
    });

    it("accepts avgTrade within the 15% tolerance and rejects beyond it", async () => {
        const counts = { totalTrades: 10, winningTrades: 5, losingTrades: 5 };
        const trades = [v2Trade(), v2Trade(), v2Trade(), v2Trade(), v2Trade()];
        // netProfit 100 over 10 trades expects avgTrade 10 with a 1.5
        // tolerance (15% of the expectation).
        const atEdge = acceptanceClient(tradeResponse({
            ...counts,
            trades,
            netProfit: 100,
            winRate: 50,
            avgTrade: 11.5,
            profitFactor: 1,
        }));
        const atEdgeResult = await atEdge.runBacktestWithStatus(data, [], 10_000, 100, 0.1, settings);
        expect(atEdgeResult.ok, JSON.stringify(atEdgeResult)).to.equal(true);

        const beyond = acceptanceClient(tradeResponse({
            ...counts,
            trades,
            netProfit: 100,
            winRate: 50,
            avgTrade: 11.6,
            profitFactor: 1,
        }));
        const beyondResult = await beyond.runBacktestWithStatus(data, [], 10_000, 100, 0.1, settings);
        expect(beyondResult).to.deep.include({ ok: false, reason: "malformed_response" });
    });

    it("accepts a valid zero-trade result and normalizes null profitFactor to 0", async () => {
        const client = acceptanceClient(tradeResponse({
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            profitFactor: null,
        }));

        const result = await client.runBacktestWithStatus(data, [], 10_000, 100, 0.1, settings);

        expect(result.ok, JSON.stringify(result)).to.equal(true);
        if (result.ok) expect(result.result.profitFactor).to.equal(0);
    });

    it("normalizes null profitFactor to infinity for an all-winning run", async () => {
        const client = acceptanceClient(tradeResponse({
            trades: [v2Trade()],
            totalTrades: 1,
            winningTrades: 1,
            losingTrades: 0,
            netProfit: 10,
            winRate: 100,
            avgTrade: 10,
            profitFactor: null,
        }));

        const result = await client.runBacktestWithStatus(data, [], 10_000, 100, 0.1, settings);

        expect(result.ok, JSON.stringify(result)).to.equal(true);
        if (result.ok) expect(result.result.profitFactor).to.equal(Number.POSITIVE_INFINITY);
    });

    it("rejects null profitFactor for a mixed winning and losing run", async () => {
        const client = acceptanceClient(tradeResponse({
            trades: [v2Trade(), v2Trade()],
            totalTrades: 2,
            winningTrades: 1,
            losingTrades: 1,
            netProfit: 5,
            winRate: 50,
            avgTrade: 2.5,
            profitFactor: null,
        }));

        const result = await client.runBacktestWithStatus(data, [], 10_000, 100, 0.1, settings);

        expect(result).to.deep.include({ ok: false, reason: "malformed_response" });
    });

    it("rejects a trade entry that omits its numeric fields", async () => {
        const client = acceptanceClient(tradeResponse({
            trades: [{ exitReason: "signal" }],
            totalTrades: 1,
            winningTrades: 0,
            losingTrades: 1,
            netProfit: -10,
            winRate: 0,
            avgTrade: -10,
        }));

        const result = await client.runBacktestWithStatus(data, [], 10_000, 100, 0.1, settings);

        expect(result).to.deep.include({ ok: false, reason: "malformed_response" });
    });

    it("rejects a trade entry carrying non-numeric prices", async () => {
        const trade = v2Trade();
        trade.entryPrice = "100";
        const client = acceptanceClient(tradeResponse({
            trades: [trade],
            totalTrades: 1,
            winningTrades: 0,
            losingTrades: 1,
            netProfit: -10,
            winRate: 0,
            avgTrade: -10,
        }));

        const result = await client.runBacktestWithStatus(data, [], 10_000, 100, 0.1, settings);

        expect(result).to.deep.include({ ok: false, reason: "malformed_response" });
    });

    it("rejects an equity point whose value is not a number", async () => {
        // The audit repro: summary metrics stay valid while one equity point
        // carries a string value.
        const malformed = tradeResponse({
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
        });
        malformed.equityCurve = [{ time: 1, value: "invalid-equity" }];
        const client = acceptanceClient(malformed);

        const result = await client.runBacktestWithStatus(data, [], 10_000, 100, 0.1, settings);

        expect(result).to.deep.include({ ok: false, reason: "malformed_response" });
    });

    it("rejects an equity point with an unparseable time", async () => {
        const malformed = tradeResponse({
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
        });
        malformed.equityCurve = [{ time: "not-a-time", value: 10_000 }];
        const client = acceptanceClient(malformed);

        const result = await client.runBacktestWithStatus(data, [], 10_000, 100, 0.1, settings);

        expect(result).to.deep.include({ ok: false, reason: "malformed_response" });
    });

    it("accepts populated trade and equity history and preserves entry values", async () => {
        const winner = { ...v2Trade(), id: 1, pnl: 5, pnlPercent: 5 };
        const loser = { ...v2Trade(), id: 2, pnl: -5, pnlPercent: -5 };
        const response = tradeResponse({
            trades: [winner, loser],
            totalTrades: 2,
            winningTrades: 1,
            losingTrades: 1,
            netProfit: 0,
            winRate: 50,
            avgTrade: 0,
            profitFactor: 1,
        });
        response.equityCurve = [
            { time: 1, value: 10_000 },
            { time: 60_000, value: 9_500 },
            { time: 120_000, value: 10_000 },
        ];
        const client = acceptanceClient(response);

        const result = await client.runBacktestWithStatus(data, [], 10_000, 100, 0.1, settings);

        expect(result.ok, JSON.stringify(result)).to.equal(true);
        if (result.ok) {
            expect(result.result.trades).to.have.lengthOf(2);
            expect(result.result.trades[0]).to.include({ entryPrice: 100, exitReason: "signal" });
            expect(result.result.equityCurve).to.deep.equal(response.equityCurve);
        }
    });
});
