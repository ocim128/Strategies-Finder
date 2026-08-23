import { expect } from "chai";
import { describe, it } from "node:test";
import { RustEngineClient } from "../lib/rust-engine-client";
import type { BacktestSettings, OHLCVData, Time } from "../lib/types/strategies";

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
});
