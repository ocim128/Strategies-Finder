import { expect } from "chai";
import { afterEach, describe, it } from "node:test";
import {
    __testInternals,
    processDirectionForecast,
} from "../lib/batch-backtest/batch-backtest-vite-plugin";
import type { BatchDirectionForecastStreamEvent } from "../lib/batch-backtest/batch-backtest-stream-types";
import type { BatchSyntheticPairArtifact } from "../lib/batch-backtest/batch-synthetic-state-miner";
import type { BacktestResult, OHLCVData, Signal, Time } from "../lib/types/strategies";

function candles(length: number): OHLCVData[] {
    return Array.from({ length }, (_, index) => ({
        time: (1_700_000_000 + index * 300) as Time,
        open: 100 + (index % 5 === 4 ? 3 : 0),
        high: 104,
        low: 99,
        close: 100 + (index % 5 === 4 ? 3 : 0),
        volume: 1_000,
    }));
}

function result(): BacktestResult {
    return {
        trades: [], netProfit: 0, netProfitPercent: 0, winRate: 0, expectancy: 0,
        avgTrade: 0, profitFactor: 0, maxDrawdown: 0, maxDrawdownPercent: 0,
        totalTrades: 0, winningTrades: 0, losingTrades: 0, avgWin: 0, avgLoss: 0,
        sharpeRatio: 0, equityCurve: [],
    };
}

function artifact(data: OHLCVData[]): BatchSyntheticPairArtifact {
    const signals: Signal[] = Array.from({ length: 11 }, (_, index) => 2 + index * 5).map((barIndex) => ({
        time: data[barIndex]!.time,
        type: "buy",
        price: data[barIndex]!.close,
        barIndex,
    }));
    return {
        symbol: "AAA+BBB",
        baseAsset: "AAA",
        quoteAsset: "BBB",
        baseSymbol: "AAAUSDT",
        quoteSymbol: "BBBUSDT",
        data,
        signals,
        result: result(),
    };
}

afterEach(async () => {
    __testInternals.setMinerOwnerForTests(0);
    __testInternals.setDirectionContextForTests({ fingerprint: null, interval: null, execution: null });
    await __testInternals.releaseLastResults("direction_forecast_test_cleanup");
});

describe("Batch Direction Forecast server plugin", () => {
    it("streams scalar forecasts and a path while retaining artifacts", async () => {
        const data = candles(60);
        __testInternals.ensureMineArtifactDirForTests();
        const store = __testInternals.getArtifactStoreForTests()!;
        store.metas = [{
            symbol: "AAA+BBB", baseAsset: "AAA", quoteAsset: "BBB",
            baseSymbol: "AAAUSDT", quoteSymbol: "BBBUSDT", filePath: "unused.bin",
        }];
        __testInternals.setDirectionContextForTests({
            fingerprint: "forecast-fp",
            interval: "5m",
            execution: { initialCapital: 12_345, commissionPercent: 0.1, slippageBps: 5 },
        });
        const owner = 7_001;
        __testInternals.setMinerOwnerForTests(owner);
        const events: BatchDirectionForecastStreamEvent[] = [];
        await processDirectionForecast(
            "forecast-fp",
            "5m",
            (event) => events.push(event),
            owner,
            async () => data,
            async () => artifact(data),
        );

        expect(events[0]!.type).to.equal("start");
        expect(events.filter((event) => event.type === "forecast")).to.have.length(2);
        const path = events.find((event): event is Extract<BatchDirectionForecastStreamEvent, { type: "path" }> => event.type === "path")!;
        expect(path.result.path.startEquity).to.equal(12_345);
        expect(events.at(-1)!.type).to.equal("done");
        expect(__testInternals.hasStoredMineArtifacts()).to.equal(true);
        const wire = JSON.stringify(events);
        expect(wire).to.not.match(/"(data|signals|equityCurve)"\s*:/);
        expect(wire).to.not.match(/"trades"\s*:\s*\[/);
    });

    it("rejects ambiguous exact target identities", () => {
        const requests = __testInternals.resolveDirectionTargetRequestsForTests([
            { symbol: "AAA+BBB", baseAsset: "AAA", quoteAsset: "BBB", baseSymbol: "AAAUSDT", quoteSymbol: "BBBUSDT", filePath: "a" },
            { symbol: "AAA+CCC", baseAsset: "AAA", quoteAsset: "CCC", baseSymbol: "AAA\u2022", quoteSymbol: "CCC\u2022", filePath: "b" },
        ]);
        const aaa = requests.find((request) => request.asset === "AAA")!;
        expect(aaa.symbol).to.equal(null);
        expect(aaa.unavailableReason).to.equal("TARGET_IDENTITY_AMBIGUOUS");
    });

    it("registers the local-only Direction Forecast route", async () => {
        const routes = new Map<string, (req: any, res: any) => Promise<void>>();
        __testInternals.registerBatchRoutesForTests({ use: (path: string, handler: (req: any, res: any) => Promise<void>) => routes.set(path, handler) });
        const handler = routes.get("/api/batch-backtest/direction-forecast");
        expect(handler).to.not.equal(undefined);
        const response = { statusCode: 0, body: "", setHeader() {}, end(body: string) { this.body = body; } };
        await handler!({ method: "POST", headers: {} }, response);
        expect(response.statusCode).to.equal(401);
        expect(JSON.parse(response.body).error).to.include("local-only");
    });
});
