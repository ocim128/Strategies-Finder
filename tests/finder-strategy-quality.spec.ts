import { expect } from "chai";
import { describe, it } from "node:test";
import {
    buildStrategyQualityResult,
    optimizeQualitySymbolOrder,
    runStrategyQualityAudit,
    sortStrategyQualityResultsByMetric,
} from "../lib/finder/finder-strategy-quality";
import type { FinderSelectedStrategy } from "../lib/finder/finder-runner";
import type { CapitalSettings } from "../lib/types/backtest";
import type { FinderStrategyQualitySymbolResult } from "../lib/types/finder";
import type { BacktestSettings, Strategy } from "../lib/types/strategies";

function makeStrategy(key = "quality_test", name = "Quality Test Strategy"): FinderSelectedStrategy {
    const strategy: Strategy = {
        name,
        description: "test",
        defaultParams: { lookback: 10 },
        paramLabels: { lookback: "Lookback" },
        execute: () => [],
    };
    return { key, name: strategy.name, strategy };
}

function makeSymbol(
    symbol: string,
    result?: Partial<NonNullable<FinderStrategyQualitySymbolResult["result"]>>,
): FinderStrategyQualitySymbolResult {
    if (!result) {
        return { symbol, status: "no_trades", barCount: 100 };
    }
    const complete = {
        netProfit: 30,
        netProfitPercent: 3,
        expectancy: 10,
        winRate: 60,
        profitFactor: 2,
        totalTrades: 3,
        winningTrades: 2,
        losingTrades: 1,
        avgWin: 30,
        avgLoss: 30,
        sharpeRatio: 1.2,
        maxDrawdownPercent: 4,
        ...result,
    };
    return {
        symbol,
        status: complete.netProfit > 0 ? "profitable" : "losing",
        barCount: 100,
        result: complete,
    };
}

describe("Finder Strategy Quality aggregation", () => {
    it("clusters synthetic pairs that share legs for bounded-cache reuse", () => {
        const symbols = [
            "A\u2022+B\u2022",
            "X\u2022+Y\u2022",
            "A\u2022+C\u2022",
            "Z\u2022+Q\u2022",
            "A\u2022+D\u2022",
        ];
        const optimized = optimizeQualitySymbolOrder(symbols);

        expect(optimized).to.have.length(symbols.length);
        expect(new Set(optimized)).to.deep.equal(new Set(symbols));
        expect(optimized.indexOf("A\u2022+C\u2022")).to.be.lessThan(optimized.indexOf("X\u2022+Y\u2022"));
        expect(optimized.indexOf("A\u2022+D\u2022")).to.be.lessThan(optimized.indexOf("Z\u2022+Q\u2022"));
    });

    it("keeps no-trade breadth visible and recomputes aggregate quality metrics", () => {
        const result = buildStrategyQualityResult(
            makeStrategy(),
            [
                makeSymbol("AAA", {
                    netProfit: 30,
                    expectancy: 10,
                    totalTrades: 3,
                    winningTrades: 2,
                    losingTrades: 1,
                    avgWin: 30,
                    avgLoss: 30,
                    sharpeRatio: 1.2,
                    maxDrawdownPercent: 4,
                }),
                makeSymbol("BBB", {
                    netProfit: -10,
                    expectancy: -5,
                    totalTrades: 2,
                    winningTrades: 1,
                    losingTrades: 1,
                    avgWin: 20,
                    avgLoss: 30,
                    sharpeRatio: -0.4,
                    maxDrawdownPercent: 8,
                }),
                makeSymbol("CCC"),
            ],
            3,
            false,
        );

        expect(result.activeSymbols).to.equal(2);
        expect(result.noTradeSymbols).to.equal(1);
        expect(result.profitableSymbols).to.equal(1);
        expect(result.totalTrades).to.equal(5);
        expect(result.totalNetProfit).to.equal(20);
        expect(result.averageExpectancy).to.equal(2.5);
        expect(result.medianExpectancy).to.equal(2.5);
        // Gross profit = 2*30 + 1*20; gross loss = 30 + 30.
        expect(result.profitFactor).to.equal(80 / 60);
        expect(result.weightedWinRate).to.equal(60);
        expect(result.worstMaxDrawdownPercent).to.equal(8);
    });

    it("re-sorts quality results by robust aggregate metrics without mutating the input", () => {
        const low = buildStrategyQualityResult(
            makeStrategy("low", "Low Quality"),
            [makeSymbol("AAA", { expectancy: 1, maxDrawdownPercent: 20 })],
            1,
            false,
        );
        const high = buildStrategyQualityResult(
            makeStrategy("high", "High Quality"),
            [makeSymbol("AAA", { expectancy: 5, maxDrawdownPercent: 10 })],
            1,
            false,
        );
        const original = [low, high];

        expect(sortStrategyQualityResultsByMetric(original, "medianExpectancy").map((item) => item.strategyKey))
            .to.deep.equal(["high", "low"]);
        expect(sortStrategyQualityResultsByMetric(original, "worstMaxDrawdownPercent").map((item) => item.strategyKey))
            .to.deep.equal(["high", "low"]);
        expect(original.map((item) => item.strategyKey)).to.deep.equal(["low", "high"]);
    });

    it("retains normalized default parameters as the audit identity", () => {
        const selected = makeStrategy();
        selected.strategy.normalizeParams = (params) => ({ ...params, lookback: Math.max(20, params.lookback) });

        const result = buildStrategyQualityResult(selected, [makeSymbol("AAA")], 1, false);

        expect(result.params).to.deep.equal({ lookback: 20 });
    });

    it("retains symbol load errors so a zero-load audit can be diagnosed", async () => {
        const output = await runStrategyQualityAudit({
            selectedStrategies: [makeStrategy()],
            symbols: ["AAA"],
            interval: "1d",
            dataSlice: "all",
            oosValidationEnabled: false,
            settings: {} as BacktestSettings,
            capitalSettings: {} as CapitalSettings,
            loadDataset: async () => {
                throw new Error("local dataset unavailable");
            },
            getProvider: () => "local-daily",
            yieldControl: async () => undefined,
            isCancelled: () => false,
            setProgress: () => undefined,
            setStatus: () => undefined,
        });

        expect(output.loadedSymbols).to.equal(0);
        expect(output.failedSymbols).to.equal(1);
        expect(output.failedSymbolDetails).to.deep.equal([
            { symbol: "AAA", error: "local dataset unavailable" },
        ]);
        expect(output.results[0]?.symbols[0]?.status).to.equal("load_failed");
        expect(output.performance.runs).to.deep.include({ planned: 1, completed: 1, failed: 1 });
        expect(output.performance.timingsMs.total).to.be.at.least(0);
    });

    it("overlaps only a bounded number of dataset loads", async () => {
        let activeLoads = 0;
        let maxActiveLoads = 0;
        const candle = { time: "2020-01-01", open: 1, high: 1, low: 1, close: 1, volume: 1 };
        const output = await runStrategyQualityAudit({
            selectedStrategies: [makeStrategy()],
            symbols: ["A", "B", "C", "D", "E"],
            interval: "1d",
            dataSlice: "all",
            oosValidationEnabled: false,
            settings: {} as BacktestSettings,
            capitalSettings: {} as CapitalSettings,
            loadDataset: async () => {
                activeLoads += 1;
                maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
                await Promise.resolve();
                activeLoads -= 1;
                return [candle];
            },
            getProvider: () => "local-daily",
            yieldControl: async () => undefined,
            isCancelled: () => false,
            setProgress: () => undefined,
            setStatus: () => undefined,
        });

        expect(output.loadedSymbols).to.equal(5);
        expect(maxActiveLoads).to.equal(4);
    });
});
