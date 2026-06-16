import { expect } from "chai";
import { describe, it } from "node:test";
import { buildFinderUniverseCandidate, computePerformanceVerdict, computeStrategyVerdict, passesFinderUniverseFilters, sortFinderUniverseCandidates } from "../lib/finder/finder-universe-metrics";
import type { FinderUniverseSymbolMetrics, FinderUniverseSymbolResult } from "../lib/types/finder";

function makeBacktestResult(netProfit: number, expectancy: number, totalTrades: number, sharpeRatio = 0, profitFactor = 0): FinderUniverseSymbolMetrics {
    return {
        netProfit,
        netProfitPercent: 0,
        expectancy,
        avgTrade: 0,
        winRate: 0,
        profitFactor,
        maxDrawdownPercent: 0,
        totalTrades,
        winningTrades: 0,
        losingTrades: 0,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio,
    };
}

function makeSymbol(symbol: string, status: FinderUniverseSymbolResult["status"], result?: FinderUniverseSymbolMetrics): FinderUniverseSymbolResult {
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

    it("aggregates median sharpe ratio across active symbols", () => {
        const candidate = buildFinderUniverseCandidate({
            strategyKey: "demo",
            strategyName: "Demo",
            params: { threshold: 1 },
            symbols: [
                makeSymbol("BTCUSDT", "profitable", makeBacktestResult(120, 4, 8, 1.5)),
                makeSymbol("ETHUSDT", "losing", makeBacktestResult(-40, -2, 4, 0.5)),
                makeSymbol("SOLUSDT", "no_trades", makeBacktestResult(0, 0, 0, 9)),
            ],
        });

        // median of [1.5, 0.5] = 1.0; no_trades symbol excluded
        expect(candidate.medianSharpe).to.equal(1.0);
    });

    it("sorts survivors by median sharpe ratio", () => {
        const sharper = buildFinderUniverseCandidate({
            strategyKey: "sharper",
            strategyName: "Sharper",
            params: { threshold: 1 },
            symbols: [
                makeSymbol("BTCUSDT", "profitable", makeBacktestResult(15, 3, 5, 2.0)),
                makeSymbol("ETHUSDT", "profitable", makeBacktestResult(10, 2, 5, 1.8)),
            ],
        });
        const flatter = buildFinderUniverseCandidate({
            strategyKey: "flatter",
            strategyName: "Flatter",
            params: { threshold: 2 },
            symbols: [
                makeSymbol("BTCUSDT", "profitable", makeBacktestResult(5, 1, 4, 0.3)),
                makeSymbol("ETHUSDT", "losing", makeBacktestResult(-10, -1, 4, 0.1)),
            ],
        });

        const sorted = sortFinderUniverseCandidates(
            [flatter, sharper],
            ["medianSharpe"]
        );

        expect(sorted.map((item) => item.strategyKey)).to.deep.equal(["sharper", "flatter"]);
    });
});

describe("Performance verdict", () => {
    it("returns NO SIGNAL for missing results or failure states", () => {
        expect(computePerformanceVerdict(undefined, "no_trades").label).to.equal("NO SIGNAL");
        expect(computePerformanceVerdict(undefined, "load_failed").label).to.equal("NO SIGNAL");
        expect(computePerformanceVerdict(undefined, "run_failed").label).to.equal("NO SIGNAL");
        expect(computePerformanceVerdict(makeBacktestResult(0, 0, 0), "no_trades").label).to.equal("NO SIGNAL");
    });

    it("returns THIN for profitable symbols with too few trades", () => {
        const thin = makeBacktestResult(50, 3, 10, 2.0, 3.0);
        expect(computePerformanceVerdict(thin, "profitable").label).to.equal("THIN");
        expect(computePerformanceVerdict(thin, "profitable").tier).to.equal(5);
    });

    it("returns LOSING for negative netProfit with sufficient trades", () => {
        const losing = makeBacktestResult(-30, -1, 20, 0.3, 0.8);
        expect(computePerformanceVerdict(losing, "losing").label).to.equal("LOSING");
        expect(computePerformanceVerdict(losing, "losing").tier).to.equal(4);
    });

    it("returns STRONG for high PF and Sharpe", () => {
        const strong = makeBacktestResult(120, 4, 30, 1.5, 1.8);
        expect(computePerformanceVerdict(strong, "profitable").label).to.equal("STRONG");
        expect(computePerformanceVerdict(strong, "profitable").tier).to.equal(0);
    });

    it("returns SOLID for decent PF and Sharpe", () => {
        const solid = makeBacktestResult(80, 2, 25, 0.7, 1.3);
        expect(computePerformanceVerdict(solid, "profitable").label).to.equal("SOLID");
        expect(computePerformanceVerdict(solid, "profitable").tier).to.equal(1);
    });

    it("returns MARGINAL for barely profitable PF", () => {
        const marginal = makeBacktestResult(10, 0.5, 20, 0.2, 1.1);
        expect(computePerformanceVerdict(marginal, "profitable").label).to.equal("MARGINAL");
    });

    it("returns WEAK for profitable but PF below 1.05", () => {
        const weak = makeBacktestResult(2, 0.1, 20, 0.1, 1.02);
        expect(computePerformanceVerdict(weak, "profitable").label).to.equal("WEAK");
    });

    it("THIN takes priority over profitability grade", () => {
        // Even with amazing metrics, few trades means unreliable
        const thin = makeBacktestResult(50, 5, 5, 3.0, 2.5);
        expect(computePerformanceVerdict(thin, "profitable").label).to.equal("THIN");
    });
});

describe("Strategy verdict", () => {
    it("flags 100% profitable ratio as UNIFORM (directional bias warning)", () => {
        expect(computeStrategyVerdict(1.0).label).to.include("UNIFORM");
        expect(computeStrategyVerdict(1.0).cssClass).to.equal("finder-verdict-uniform");
    });

    it("classifies broad edge at >= 85%", () => {
        expect(computeStrategyVerdict(0.85).label).to.equal("BROAD EDGE");
        expect(computeStrategyVerdict(0.9).label).to.equal("BROAD EDGE");
    });

    it("classifies moderate at >= 65%", () => {
        expect(computeStrategyVerdict(0.65).label).to.equal("MODERATE");
        expect(computeStrategyVerdict(0.7).label).to.equal("MODERATE");
    });

    it("classifies selective at >= 45%", () => {
        expect(computeStrategyVerdict(0.5).label).to.equal("SELECTIVE");
    });

    it("classifies narrow below 45%", () => {
        expect(computeStrategyVerdict(0.3).label).to.equal("NARROW");
    });
});
