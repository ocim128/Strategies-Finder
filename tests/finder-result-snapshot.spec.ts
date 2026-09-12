import { expect } from "chai";
import { describe, it } from "node:test";
import {
    FINDER_RESULT_SNAPSHOT_LIMIT,
    compactFinderLatestResults,
    normalizeFinderLatestResultsSnapshot,
} from "../lib/finder/finder-result-snapshot";
import type { FinderAssetOpportunityResult, FinderLatestResults, FinderResult, FinderUniverseCandidate } from "../lib/types/finder";
import type { BacktestResult, Time } from "../lib/types/strategies";

function makeBacktestResult(overrides: Partial<BacktestResult> = {}): BacktestResult {
    return {
        trades: [{ entryTime: 1, exitTime: 2 } as any],
        netProfit: 100,
        netProfitPercent: 10,
        winRate: 60,
        expectancy: 2,
        avgTrade: 1,
        profitFactor: 1.5,
        maxDrawdown: 25,
        maxDrawdownPercent: 5,
        totalTrades: 10,
        winningTrades: 6,
        losingTrades: 4,
        avgWin: 5,
        avgLoss: 3,
        sharpeRatio: 1.2,
        equityCurve: [{ time: 1 as Time, value: 1000 }],
        ...overrides,
    };
}

function makeFinderResult(index: number): FinderResult {
    return {
        key: `strategy_${index}`,
        name: `Strategy ${index}`,
        params: { lookback: index },
        result: makeBacktestResult({ netProfit: index }),
        selectionResult: makeBacktestResult({ netProfit: index }),
        endpointAdjusted: false,
        endpointRemovedTrades: 0,
    };
}

function makeUniverseCandidate(index: number): FinderUniverseCandidate {
    return {
        strategyKey: `strategy_${index}`,
        strategyName: `Strategy ${index}`,
        params: { lookback: index },
        symbols: Array.from({ length: 250 }, (_, symbolIndex) => ({
            symbol: `SYM${symbolIndex}`,
            status: "profitable",
            barCount: 100,
            result: {
                netProfit: symbolIndex,
                netProfitPercent: 1,
                expectancy: 1,
                avgTrade: 1,
                winRate: 55,
                profitFactor: 1.2,
                totalTrades: 5,
                maxDrawdownPercent: 2,
                winningTrades: 3,
                losingTrades: 2,
                avgWin: 4,
                avgLoss: 2,
                sharpeRatio: 0.8,
            },
        })),
        activeSymbols: 250,
        profitableSymbols: 250,
        losingSymbols: 0,
        flatSymbols: 0,
        noTradeSymbols: 0,
        totalTrades: 1250,
        profitableActiveRatio: 1,
        medianExpectancy: 1,
        medianSharpe: 0.8,
        medianSharpeAvailable: false,
        medianProfitFactor: 1.2,
        medianNetProfit: 10,
        worstNetProfit: 1,
        bestNetProfit: 100,
        medianCompositeEdgeRatio: 0,
        drawdownMetricsAvailable: true,
        worstMaxDrawdownPercent: 4,
        medianMaxDrawdownPercent: 2,
        medianReturnDrawdownRatio: 0.5,
        robustUniverseScore: 90,
        windowStabilityScore: 0,
    };
}

function makeAssetOpportunityResult(index: number): FinderAssetOpportunityResult {
    return {
        symbol: `ASSET${index}`,
        strategyKey: "strategy_1",
        strategyName: "Strategy 1",
        params: { lookback: index },
        historicalRank: 1,
        totalCandidatesEvaluated: 10,
        isHistoricalBest: true,
        freshStatus: "fresh",
        direction: "long",
        latestSignalTime: 100 as Time,
        signalAgeBars: 0,
        fillTiming: "signal_close",
        selectionResult: makeBacktestResult(),
        medianBarsToTp: 3.5,
        support: {
            freshLongCandidates: 2,
            freshShortCandidates: 0,
            freshSameDirection: 2,
            poolSize: 10,
            bestFreshRank: 1,
            directionAgreementRatio: 1,
        },
        grade: "select",
    };
}

describe("Finder result snapshots", () => {
    it("keeps current-chart snapshots bounded and strips heavy backtest arrays", () => {
        const compact = compactFinderLatestResults({
            scope: "current_chart",
            results: Array.from({ length: FINDER_RESULT_SNAPSHOT_LIMIT + 5 }, (_, index) => makeFinderResult(index)),
        });

        expect(compact.results).to.have.length(FINDER_RESULT_SNAPSHOT_LIMIT);
        expect(compact.scope).to.equal("current_chart");
        if (compact.scope !== "current_chart") throw new Error("unexpected scope");
        expect(compact.results[0]!.result.trades).to.deep.equal([]);
        expect(compact.results[0]!.result.equityCurve).to.deep.equal([]);
        expect(compact.results[0]!.selectionResult.netProfit).to.equal(0);
    });

    it("keeps universe snapshots bounded at result and symbol levels", () => {
        const compact = compactFinderLatestResults({
            scope: "symbol_universe",
            results: Array.from({ length: FINDER_RESULT_SNAPSHOT_LIMIT + 5 }, (_, index) => makeUniverseCandidate(index)),
        });

        expect(compact.results).to.have.length(FINDER_RESULT_SNAPSHOT_LIMIT);
        expect(compact.scope).to.equal("symbol_universe");
        if (compact.scope !== "symbol_universe") throw new Error("unexpected scope");
        expect(compact.results[0]!.symbols).to.have.length(200);
    });

    it("rejects malformed snapshots", () => {
        expect(normalizeFinderLatestResultsSnapshot(null)).to.equal(null);
        expect(normalizeFinderLatestResultsSnapshot({ scope: "current_chart" })).to.equal(null);
        expect(normalizeFinderLatestResultsSnapshot({ scope: "other", results: [] })).to.equal(null);
    });

    it("normalizes valid snapshots through the same compact path", () => {
        const normalized = normalizeFinderLatestResultsSnapshot({
            scope: "current_chart",
            results: [makeFinderResult(1)],
        }) as FinderLatestResults;

        expect(normalized.scope).to.equal("current_chart");
        if (normalized.scope !== "current_chart") throw new Error("unexpected scope");
        expect(normalized.results[0]!.result.trades).to.deep.equal([]);
    });

    it("keeps asset-opportunity snapshots scalar and bounded", () => {
        const compact = compactFinderLatestResults({
            scope: "asset_opportunity",
            results: Array.from({ length: FINDER_RESULT_SNAPSHOT_LIMIT + 5 }, (_, index) => ({
                ...makeAssetOpportunityResult(index),
                oosHorizonMetrics: {
                    ignoreLastBars: 20,
                    horizons: [
                        { bars: 1, pnlPercent: 1, averagePnlPercent: 1, winRatePercent: 100, sampleSize: 1 },
                        { bars: 3, pnlPercent: null, averagePnlPercent: null, winRatePercent: null, sampleSize: 0 },
                        { bars: 5, pnlPercent: -2, averagePnlPercent: -2, winRatePercent: 0, sampleSize: 1 },
                    ],
                },
                oosNextExitMetrics: {
                    ignoreLastBars: 20,
                    status: "censored",
                    pnlPercent: null,
                    exitReason: "end_of_data",
                    unavailableReason: null,
                    barsHeld: 4,
                    exitTime: 200 as Time,
                },
            })),
        });

        expect(compact.scope).to.equal("asset_opportunity");
        if (compact.scope !== "asset_opportunity") throw new Error("unexpected scope");
        expect(compact.results).to.have.length(FINDER_RESULT_SNAPSHOT_LIMIT);
        expect(compact.results[0]!.selectionResult.trades).to.deep.equal([]);
        expect(compact.results[0]!.selectionResult.equityCurve).to.deep.equal([]);
        expect(compact.results[0]!.medianBarsToTp).to.equal(3.5);
        expect(compact.results[0]!.oosHorizonMetrics?.ignoreLastBars).to.equal(20);
        expect(compact.results[0]!.oosHorizonMetrics?.horizons[2]?.pnlPercent).to.equal(-2);
        expect(compact.results[0]!.oosNextExitMetrics).to.deep.equal({
            ignoreLastBars: 20,
            status: "censored",
            pnlPercent: null,
            exitReason: "end_of_data",
            unavailableReason: null,
            barsHeld: 4,
            exitTime: 200,
        });
    });

    it("defaults new drawdown aggregates when restoring an older universe snapshot", () => {
        const legacyCandidate = makeUniverseCandidate(1) as unknown as Record<string, unknown>;
        delete legacyCandidate.drawdownMetricsAvailable;
        delete legacyCandidate.worstMaxDrawdownPercent;
        delete legacyCandidate.medianMaxDrawdownPercent;
        delete legacyCandidate.medianReturnDrawdownRatio;

        const normalized = normalizeFinderLatestResultsSnapshot({
            scope: "symbol_universe",
            results: [legacyCandidate],
        });

        expect(normalized?.scope).to.equal("symbol_universe");
        if (!normalized || normalized.scope !== "symbol_universe") throw new Error("unexpected scope");
        expect(normalized.results[0]!.drawdownMetricsAvailable).to.equal(false);
        expect(normalized.results[0]!.worstMaxDrawdownPercent).to.equal(0);
        expect(normalized.results[0]!.medianMaxDrawdownPercent).to.equal(0);
        expect(normalized.results[0]!.medianReturnDrawdownRatio).to.equal(0);
    });
});
