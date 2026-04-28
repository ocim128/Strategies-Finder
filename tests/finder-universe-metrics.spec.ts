import { expect } from "chai";
import { describe, it } from "node:test";
import { buildFinderUniverseCandidate, passesFinderUniverseFilters, sortFinderUniverseCandidates } from "../lib/finder/finder-universe-metrics";
import type { FinderUniverseSymbolResult } from "../lib/types/finder";
import type { BacktestResult } from "../lib/types/strategies";

function makeBacktestResult(netProfit: number, expectancy: number, totalTrades: number): BacktestResult {
    return {
        trades: [],
        netProfit,
        netProfitPercent: 0,
        winRate: 0,
        expectancy,
        avgTrade: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades,
        winningTrades: 0,
        losingTrades: 0,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
    };
}

function makeSymbol(symbol: string, status: FinderUniverseSymbolResult["status"], result?: BacktestResult): FinderUniverseSymbolResult {
    return {
        symbol,
        status,
        barCount: 100,
        firstTime: 1700000000,
        lastTime: 1700003600,
        result,
    };
}

describe("Finder universe metrics", () => {
    it("aggregates symbol outcomes into survivor metrics", () => {
        const candidate = buildFinderUniverseCandidate({
            strategyKey: "demo",
            strategyName: "Demo",
            params: { threshold: 1 },
            symbols: [
                makeSymbol("BTCUSDT", "profitable", makeBacktestResult(120, 4, 8)),
                makeSymbol("ETHUSDT", "losing", makeBacktestResult(-40, -2, 4)),
                makeSymbol("SOLUSDT", "no_trades", makeBacktestResult(0, 0, 0)),
            ],
        });

        expect(candidate.activeSymbols).to.equal(2);
        expect(candidate.profitableSymbols).to.equal(1);
        expect(candidate.losingSymbols).to.equal(1);
        expect(candidate.noTradeSymbols).to.equal(1);
        expect(candidate.totalTrades).to.equal(12);
        expect(candidate.profitableActiveRatio).to.equal(0.5);
        expect(candidate.medianExpectancy).to.equal(1);
        expect(candidate.worstNetProfit).to.equal(-40);
        expect(candidate.bestNetProfit).to.equal(120);
    });

    it("applies survivor filters after aggregation", () => {
        const survivor = buildFinderUniverseCandidate({
            strategyKey: "demo",
            strategyName: "Demo",
            params: { threshold: 2 },
            symbols: [
                makeSymbol("BTCUSDT", "profitable", makeBacktestResult(20, 2, 6)),
                makeSymbol("ETHUSDT", "profitable", makeBacktestResult(30, 3, 5)),
            ],
        });

        expect(passesFinderUniverseFilters(survivor, {
            symbols: ["BTCUSDT", "ETHUSDT"],
            minActiveSymbols: 2,
            minTotalTrades: 10,
            minProfitableActiveRatio: 0.75,
            sortPriority: ["profitableActiveRatio", "medianExpectancy"],
        })).to.equal(true);

        expect(passesFinderUniverseFilters(survivor, {
            symbols: ["BTCUSDT", "ETHUSDT"],
            minActiveSymbols: 3,
            minTotalTrades: 10,
            minProfitableActiveRatio: 0.75,
            sortPriority: ["profitableActiveRatio", "medianExpectancy"],
        })).to.equal(false);
    });

    it("sorts survivors by configured universe priority", () => {
        const balanced = buildFinderUniverseCandidate({
            strategyKey: "balanced",
            strategyName: "Balanced",
            params: { threshold: 1 },
            symbols: [
                makeSymbol("BTCUSDT", "profitable", makeBacktestResult(15, 3, 5)),
                makeSymbol("ETHUSDT", "profitable", makeBacktestResult(10, 2, 5)),
            ],
        });
        const weaker = buildFinderUniverseCandidate({
            strategyKey: "weaker",
            strategyName: "Weaker",
            params: { threshold: 2 },
            symbols: [
                makeSymbol("BTCUSDT", "profitable", makeBacktestResult(5, 1, 4)),
                makeSymbol("ETHUSDT", "losing", makeBacktestResult(-10, -1, 4)),
            ],
        });

        const sorted = sortFinderUniverseCandidates(
            [weaker, balanced],
            ["profitableActiveRatio", "medianExpectancy", "worstNetProfit"]
        );

        expect(sorted.map((item) => item.strategyKey)).to.deep.equal(["balanced", "weaker"]);
    });
});
