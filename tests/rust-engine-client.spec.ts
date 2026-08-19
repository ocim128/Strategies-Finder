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
});
