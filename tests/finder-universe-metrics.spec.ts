import { expect } from "chai";
import { describe, it } from "node:test";
import { buildFinderUniverseCandidate, computePerformanceVerdict, computeStrategyVerdict, computeUniverseOosAggregate, computeUniverseSymbolOosVerdict, passesFinderUniverseFilters, sortFinderUniverseCandidates, updateFinderUniverseCandidateScores } from "../lib/finder/finder-universe-metrics";
import type { FinderUniverseSymbolMetrics, FinderUniverseSymbolResult } from "../lib/types/finder";
import type { Time } from "../lib/types/strategies";

function makeBacktestResult(netProfit: number, expectancy: number, totalTrades: number, sharpeRatio = 0, profitFactor = 0, compositeEdgeRatio?: number, netProfitPercent = 0, maxDrawdownPercent = 0, drawdownAvailable = false): FinderUniverseSymbolMetrics {
    const sharpeRatioAvailable = arguments.length >= 4;
    return {
        netProfit,
        netProfitPercent,
        expectancy,
        avgTrade: 0,
        winRate: 0,
        profitFactor,
        maxDrawdownPercent,
        totalTrades,
        winningTrades: 0,
        losingTrades: 0,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio,
        sharpeRatioAvailable,
        drawdownAvailable,
        ...(typeof compositeEdgeRatio === "number" ? { compositeEdgeRatio } : {}),
    };
}

function makeSymbol(symbol: string, status: FinderUniverseSymbolResult["status"], result?: FinderUniverseSymbolMetrics): FinderUniverseSymbolResult {
    return {
        symbol,
        status,
        barCount: 100,
        firstTime: 1700000000 as Time,
        lastTime: 1700003600 as Time,
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

    it("aggregates median profit factor across active symbols", () => {
        const candidate = buildFinderUniverseCandidate({
            strategyKey: "demo",
            strategyName: "Demo",
            params: { threshold: 1 },
            symbols: [
                makeSymbol("BTCUSDT", "profitable", makeBacktestResult(120, 4, 8, 1.5, 2.0)),
                makeSymbol("ETHUSDT", "losing", makeBacktestResult(-40, -2, 4, 0.5, 0.4)),
                makeSymbol("SOLUSDT", "no_trades", makeBacktestResult(0, 0, 0, 9, 9)),
            ],
        });

        // median of [2.0, 0.4] = 1.2; no_trades symbol excluded
        expect(candidate.medianProfitFactor).to.equal(1.2);
    });

    it("sorts survivors by median profit factor", () => {
        const stronger = buildFinderUniverseCandidate({
            strategyKey: "stronger",
            strategyName: "Stronger",
            params: { threshold: 1 },
            symbols: [
                makeSymbol("BTCUSDT", "profitable", makeBacktestResult(15, 3, 5, 1.5, 2.0)),
                makeSymbol("ETHUSDT", "profitable", makeBacktestResult(10, 2, 5, 1.5, 1.8)),
            ],
        });
        const weaker = buildFinderUniverseCandidate({
            strategyKey: "weaker",
            strategyName: "Weaker",
            params: { threshold: 2 },
            symbols: [
                makeSymbol("BTCUSDT", "profitable", makeBacktestResult(5, 1, 4, 1.0, 0.6)),
                makeSymbol("ETHUSDT", "losing", makeBacktestResult(-10, -1, 4, 0.5, 0.4)),
            ],
        });

        const sorted = sortFinderUniverseCandidates(
            [weaker, stronger],
            ["medianProfitFactor"]
        );

        expect(sorted.map((item) => item.strategyKey)).to.deep.equal(["stronger", "weaker"]);
    });

    it("aggregates median composite edge ratio across active symbols", () => {
        const candidate = buildFinderUniverseCandidate({
            strategyKey: "demo",
            strategyName: "Demo",
            params: { threshold: 1 },
            symbols: [
                makeSymbol("BTCUSDT", "profitable", makeBacktestResult(120, 4, 8, 1.5, 2.0, 1.6)),
                makeSymbol("ETHUSDT", "losing", makeBacktestResult(-40, -2, 4, 0.5, 0.4, 1.2)),
                makeSymbol("SOLUSDT", "no_trades", makeBacktestResult(0, 0, 0, 9, 9, 9)),
            ],
        });

        // median of [1.6, 1.2] = 1.4; no_trades symbol excluded even though it has an ER value
        expect(candidate.medianCompositeEdgeRatio).to.equal(1.4);
    });

    it("defaults median composite edge ratio to 0 when no symbol contributed one", () => {
        const candidate = buildFinderUniverseCandidate({
            strategyKey: "demo",
            strategyName: "Demo",
            params: { threshold: 1 },
            symbols: [
                makeSymbol("BTCUSDT", "profitable", makeBacktestResult(120, 4, 8)),
                makeSymbol("ETHUSDT", "losing", makeBacktestResult(-40, -2, 4)),
            ],
        });

        expect(candidate.medianCompositeEdgeRatio).to.equal(0);
    });

    it("sorts survivors by median composite edge ratio", () => {
        const edgier = buildFinderUniverseCandidate({
            strategyKey: "edgier",
            strategyName: "Edgier",
            params: { threshold: 1 },
            symbols: [
                makeSymbol("BTCUSDT", "profitable", makeBacktestResult(15, 3, 5, 1.5, 1.6, 1.8)),
                makeSymbol("ETHUSDT", "profitable", makeBacktestResult(10, 2, 5, 1.5, 1.4, 1.6)),
            ],
        });
        const flatter = buildFinderUniverseCandidate({
            strategyKey: "flatter",
            strategyName: "Flatter",
            params: { threshold: 2 },
            symbols: [
                makeSymbol("BTCUSDT", "profitable", makeBacktestResult(5, 1, 4, 1.0, 0.8, 0.9)),
                makeSymbol("ETHUSDT", "losing", makeBacktestResult(-10, -1, 4, 0.5, 0.5, 0.7)),
            ],
        });

        const sorted = sortFinderUniverseCandidates(
            [flatter, edgier],
            ["medianCompositeEdgeRatio"]
        );

        expect(sorted.map((item) => item.strategyKey)).to.deep.equal(["edgier", "flatter"]);
    });

    it("aggregates drawdown only from active symbols where it was computed", () => {
        const candidate = buildFinderUniverseCandidate({
            strategyKey: "demo",
            strategyName: "Demo",
            params: { threshold: 1 },
            symbols: [
                makeSymbol("BTCUSDT", "profitable", makeBacktestResult(120, 4, 8, 0, 0, undefined, 24, 6, true)),
                makeSymbol("ETHUSDT", "profitable", makeBacktestResult(40, 2, 6, 0, 0, undefined, 8, 2, true)),
                makeSymbol("SOLUSDT", "losing", makeBacktestResult(-20, -1, 5, 0, 0, undefined, -5, 30, false)),
                makeSymbol("BNBUSDT", "no_trades", makeBacktestResult(0, 0, 0, 0, 0, undefined, 0, 99, true)),
            ],
        });

        expect(candidate.drawdownMetricsAvailable).to.equal(true);
        expect(candidate.worstMaxDrawdownPercent).to.equal(6);
        expect(candidate.medianMaxDrawdownPercent).to.equal(4);
        expect(candidate.medianReturnDrawdownRatio).to.equal(4);
    });

    it("ranks drawdown ascending and return-to-drawdown descending", () => {
        const makeCandidate = (strategyKey: string, netProfitPercent: number, maxDrawdownPercent: number) =>
            buildFinderUniverseCandidate({
                strategyKey,
                strategyName: strategyKey,
                params: {},
                symbols: [
                    makeSymbol("BTCUSDT", "profitable", makeBacktestResult(20, 2, 10, 0, 0, undefined, netProfitPercent, maxDrawdownPercent, true)),
                ],
            });
        const lowDrawdown = makeCandidate("low-dd", 10, 2);
        const highDrawdown = makeCandidate("high-dd", 30, 10);

        expect(sortFinderUniverseCandidates(
            [highDrawdown, lowDrawdown],
            ["worstMaxDrawdownPercent"],
        ).map((item) => item.strategyKey)).to.deep.equal(["low-dd", "high-dd"]);
        expect(sortFinderUniverseCandidates(
            [highDrawdown, lowDrawdown],
            ["medianMaxDrawdownPercent"],
        ).map((item) => item.strategyKey)).to.deep.equal(["low-dd", "high-dd"]);
        expect(sortFinderUniverseCandidates(
            [highDrawdown, lowDrawdown],
            ["medianReturnDrawdownRatio"],
        ).map((item) => item.strategyKey)).to.deep.equal(["low-dd", "high-dd"]);
    });

    it("keeps a profitable zero-drawdown return ratio finite and best-ranked", () => {
        const zeroDrawdown = buildFinderUniverseCandidate({
            strategyKey: "zero-dd",
            strategyName: "Zero DD",
            params: {},
            symbols: [
                makeSymbol("BTCUSDT", "profitable", makeBacktestResult(10, 1, 5, 0, 0, undefined, 5, 0, true)),
            ],
        });

        expect(zeroDrawdown.medianReturnDrawdownRatio).to.equal(Number.MAX_SAFE_INTEGER);
        expect(Number.isFinite(zeroDrawdown.medianReturnDrawdownRatio)).to.equal(true);
    });

    it("scores robust universe candidates higher when breadth, samples, edge, and downside all hold", () => {
        const robust = buildFinderUniverseCandidate({
            strategyKey: "robust",
            strategyName: "Robust",
            params: { threshold: 1 },
            symbols: [
                makeSymbol("BTCUSDT", "profitable", makeBacktestResult(60, 4, 20, 1.5, 1.8, 1.7)),
                makeSymbol("ETHUSDT", "profitable", makeBacktestResult(45, 3, 18, 1.2, 1.6, 1.5)),
                makeSymbol("SOLUSDT", "profitable", makeBacktestResult(30, 2, 16, 1.0, 1.4, 1.3)),
                makeSymbol("BNBUSDT", "losing", makeBacktestResult(-10, 1, 14, 0.8, 1.2, 1.1)),
            ],
        });
        const flashyButNarrow = buildFinderUniverseCandidate({
            strategyKey: "flashy",
            strategyName: "Flashy",
            params: { threshold: 2 },
            symbols: [
                makeSymbol("BTCUSDT", "profitable", makeBacktestResult(200, 10, 8, 4.0, 4.0, 4.0)),
                makeSymbol("ETHUSDT", "losing", makeBacktestResult(-160, -8, 8, -1.0, 0.2, 0.5)),
            ],
        });

        expect(robust.robustUniverseScore).to.be.greaterThan(flashyButNarrow.robustUniverseScore);

        const sorted = sortFinderUniverseCandidates(
            [flashyButNarrow, robust],
            ["robustUniverseScore"]
        );
        expect(sorted.map((item) => item.strategyKey)).to.deep.equal(["robust", "flashy"]);
    });

    it("does not treat many thin one-trade winners as robust universe breadth", () => {
        const thinWinners = buildFinderUniverseCandidate({
            strategyKey: "thin",
            strategyName: "Thin",
            params: { threshold: 1 },
            symbols: [
                makeSymbol("BTCUSDT", "profitable", makeBacktestResult(500, 500, 1, 0, Infinity, 4)),
                makeSymbol("ETHUSDT", "profitable", makeBacktestResult(400, 400, 1, 0, Infinity, 4)),
                makeSymbol("SOLUSDT", "profitable", makeBacktestResult(300, 300, 1, 0, Infinity, 4)),
                makeSymbol("BNBUSDT", "losing", makeBacktestResult(-200, -20, 10, 0, 0.2, 0.5)),
            ],
        });

        expect(thinWinners.robustUniverseScore).to.equal(0);
    });

    it("scores window stability from OOS breadth retention and re-sorts by it", () => {
        const stable = buildFinderUniverseCandidate({
            strategyKey: "stable",
            strategyName: "Stable",
            params: { threshold: 1 },
            symbols: [
                makeSymbol("BTCUSDT", "profitable", makeBacktestResult(40, 4, 12, 1.5, 1.8)),
                makeSymbol("ETHUSDT", "profitable", makeBacktestResult(30, 3, 12, 1.2, 1.6)),
                makeSymbol("SOLUSDT", "profitable", makeBacktestResult(20, 2, 12, 1.0, 1.4)),
                makeSymbol("BNBUSDT", "losing", makeBacktestResult(-5, 1, 12, 0.8, 1.2)),
            ],
        });
        stable.oosAggregate = {
            verdict: "pass",
            activeSymbols: 4,
            profitableSymbols: 2,
            profitableActiveRatio: 0.5,
            worstNetProfit: 0,
        };
        stable.symbols[0]!.oosResult = makeBacktestResult(10, 1, 8, 0.5, 1.4);
        stable.symbols[0]!.oosVerdict = "pass";
        stable.symbols[1]!.oosResult = makeBacktestResult(10, 1, 8, 0.5, 1.4);
        stable.symbols[1]!.oosVerdict = "pass";
        stable.symbols[2]!.oosResult = makeBacktestResult(-5, -1, 8, 0.5, 0.5);
        stable.symbols[2]!.oosVerdict = "fail";
        stable.symbols[3]!.oosResult = makeBacktestResult(-5, -1, 2, 0.5, 0.5);
        stable.symbols[3]!.oosVerdict = "inconclusive";

        const collapsed = buildFinderUniverseCandidate({
            strategyKey: "collapsed",
            strategyName: "Collapsed",
            params: { threshold: 2 },
            symbols: [
                makeSymbol("BTCUSDT", "profitable", makeBacktestResult(80, 8, 12, 2.0, 2.5)),
                makeSymbol("ETHUSDT", "profitable", makeBacktestResult(70, 7, 12, 1.8, 2.2)),
                makeSymbol("SOLUSDT", "profitable", makeBacktestResult(60, 6, 12, 1.6, 2.0)),
                makeSymbol("BNBUSDT", "profitable", makeBacktestResult(50, 5, 12, 1.4, 1.8)),
            ],
        });
        collapsed.oosAggregate = {
            verdict: "fail",
            activeSymbols: 4,
            profitableSymbols: 0,
            profitableActiveRatio: 0,
            worstNetProfit: -40,
        };
        for (const symbol of collapsed.symbols) {
            symbol.oosResult = makeBacktestResult(-10, -1, 8, 0.5, 0.5);
            symbol.oosVerdict = "fail";
        }

        updateFinderUniverseCandidateScores(stable);
        updateFinderUniverseCandidateScores(collapsed);

        expect(stable.windowStabilityScore).to.be.greaterThan(0);
        expect(collapsed.windowStabilityScore).to.equal(0);

        const sorted = sortFinderUniverseCandidates(
            [collapsed, stable],
            ["windowStabilityScore"]
        );
        expect(sorted.map((item) => item.strategyKey)).to.deep.equal(["stable", "collapsed"]);
    });

    it("passes per-symbol OOS verdict only when OOS is profitable with enough trades", () => {
        // Profitable + enough trades -> pass
        expect(computeUniverseSymbolOosVerdict({ oosNetProfit: 100, oosProfitFactor: 1.5, oosTotalTrades: 10, minTrades: 5 })).to.equal("pass");
        // Boundary: zero net profit and PF 1.0 still passes
        expect(computeUniverseSymbolOosVerdict({ oosNetProfit: 0, oosProfitFactor: 1.0, oosTotalTrades: 10, minTrades: 5 })).to.equal("pass");
        // Degraded -> fail
        expect(computeUniverseSymbolOosVerdict({ oosNetProfit: -50, oosProfitFactor: 0.9, oosTotalTrades: 10, minTrades: 5 })).to.equal("fail");
        // Too few OOS trades -> inconclusive regardless of profitability
        expect(computeUniverseSymbolOosVerdict({ oosNetProfit: -1000, oosProfitFactor: 0.3, oosTotalTrades: 2, minTrades: 5 })).to.equal("inconclusive");
    });

    it("aggregates per-symbol OOS into a strategy-level verdict that flags breadth collapse", () => {
        // IS ratio 0.7, OOS retains 0.6 -> pass (above 0.3 floor and above half of IS)
        const retained = computeUniverseOosAggregate({
            isProfitableActiveRatio: 0.7,
            minActiveSymbols: 2,
            symbols: [
                makeSymbol("A", "profitable", makeBacktestResult(10, 1, 8, 0.5, 1.4)),
                makeSymbol("B", "profitable", makeBacktestResult(20, 2, 9, 0.5, 1.6)),
                makeSymbol("C", "losing", makeBacktestResult(-5, -1, 7, 0.5, 0.9)),
            ].map((s) => ({ ...s, oosResult: makeBacktestResult(10, 1, 8, 0.5, 1.4) })),
        });
        expect(retained.verdict).to.equal("pass");
        expect(retained.activeSymbols).to.equal(3);
        expect(retained.profitableSymbols).to.equal(3);

        // IS ratio 0.7, OOS collapses to 0.2 profitable -> fail
        const collapsed = computeUniverseOosAggregate({
            isProfitableActiveRatio: 0.7,
            minActiveSymbols: 2,
            symbols: [
                makeSymbol("A", "profitable", makeBacktestResult(10, 1, 8, 0.5, 1.4)),
                makeSymbol("B", "profitable", makeBacktestResult(20, 2, 9, 0.5, 1.6)),
                makeSymbol("C", "profitable", makeBacktestResult(30, 3, 8, 0.5, 1.5)),
                makeSymbol("D", "profitable", makeBacktestResult(40, 4, 9, 0.5, 1.6)),
                makeSymbol("E", "losing", makeBacktestResult(-5, -1, 7, 0.5, 0.9)),
            ].map((s) => ({ ...s, oosResult: makeBacktestResult(-10, -1, 8, 0.5, 0.9) })),
        });
        expect(collapsed.verdict).to.equal("fail");
        expect(collapsed.profitableSymbols).to.equal(0);

        // Too few OOS-active symbols -> inconclusive
        const thin = computeUniverseOosAggregate({
            isProfitableActiveRatio: 0.7,
            minActiveSymbols: 5,
            symbols: [
                makeSymbol("A", "profitable", makeBacktestResult(10, 1, 8, 0.5, 1.4)),
            ].map((s) => ({ ...s, oosResult: makeBacktestResult(10, 1, 8, 0.5, 1.4) })),
        });
        expect(thin.verdict).to.equal("inconclusive");
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
