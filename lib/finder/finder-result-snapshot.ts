import type {
    FinderAssetOpportunityResult,
    FinderLatestResults,
    FinderResult,
    FinderStrategyQualityResult,
    FinderUniverseCandidate,
    FinderUniverseSymbolMetrics,
    FinderUniverseSymbolResult,
} from "../types/finder";
import type { BacktestResult, StrategyParams } from "../types/strategies";

export const FINDER_RESULT_SNAPSHOT_LIMIT = 25;
const FINDER_UNIVERSE_SYMBOL_SNAPSHOT_LIMIT = 200;

function compactBacktestResult(result: BacktestResult): BacktestResult {
    return {
        trades: [],
        netProfit: result.netProfit,
        netProfitPercent: result.netProfitPercent,
        winRate: result.winRate,
        expectancy: result.expectancy,
        avgTrade: result.avgTrade,
        profitFactor: result.profitFactor,
        maxDrawdown: result.maxDrawdown,
        maxDrawdownPercent: result.maxDrawdownPercent,
        totalTrades: result.totalTrades,
        winningTrades: result.winningTrades,
        losingTrades: result.losingTrades,
        avgWin: result.avgWin,
        avgLoss: result.avgLoss,
        sharpeRatio: result.sharpeRatio,
        equityCurve: [],
        ...(result.tradeTimingQuality ? { tradeTimingQuality: result.tradeTimingQuality } : {}),
        ...(result.polymarketTradeSummary ? { polymarketTradeSummary: result.polymarketTradeSummary } : {}),
    };
}

function compactFinderResult(result: FinderResult): FinderResult {
    return {
        key: result.key,
        name: result.name,
        params: { ...result.params },
        ...(result.exitStrategyKey ? { exitStrategyKey: result.exitStrategyKey } : {}),
        ...(result.exitStrategyParams ? { exitStrategyParams: { ...result.exitStrategyParams } } : {}),
        result: compactBacktestResult(result.result),
        selectionResult: compactBacktestResult(result.selectionResult),
        ...(Number.isFinite(result.compositeEdgeRatio) ? { compositeEdgeRatio: result.compositeEdgeRatio } : {}),
        ...(Number.isFinite(result.exitAlpha) ? { exitAlpha: result.exitAlpha } : {}),
        ...(Number.isFinite(result.oosExitAlpha) ? { oosExitAlpha: result.oosExitAlpha } : {}),
        endpointAdjusted: result.endpointAdjusted,
        endpointRemovedTrades: result.endpointRemovedTrades,
        ...(result.polymarketEval ? { polymarketEval: result.polymarketEval } : {}),
        ...(result.oosResult ? { oosResult: compactBacktestResult(result.oosResult) } : {}),
        ...(result.oosVerdict ? { oosVerdict: result.oosVerdict } : {}),
    };
}

function compactUniverseMetrics(metrics: FinderUniverseSymbolMetrics): FinderUniverseSymbolMetrics {
    const {
        netProfit, netProfitPercent, expectancy, avgTrade, winRate, profitFactor,
        totalTrades, maxDrawdownPercent, winningTrades, losingTrades, avgWin, avgLoss, sharpeRatio,
        exitAlpha,
    } = metrics;
    return {
        netProfit, netProfitPercent, expectancy, avgTrade, winRate, profitFactor,
        totalTrades, maxDrawdownPercent, winningTrades, losingTrades, avgWin, avgLoss, sharpeRatio,
        ...(metrics.sharpeRatioAvailable !== undefined ? { sharpeRatioAvailable: metrics.sharpeRatioAvailable } : {}),
        ...(metrics.drawdownAvailable !== undefined ? { drawdownAvailable: metrics.drawdownAvailable } : {}),
        ...(Number.isFinite(metrics.compositeEdgeRatio) ? { compositeEdgeRatio: metrics.compositeEdgeRatio } : {}),
        ...(Number.isFinite(exitAlpha) ? { exitAlpha } : {}),
    };
}

function compactUniverseSymbol(symbol: FinderUniverseSymbolResult): FinderUniverseSymbolResult {
    return {
        symbol: symbol.symbol,
        status: symbol.status,
        barCount: symbol.barCount,
        ...(symbol.firstTime !== undefined ? { firstTime: symbol.firstTime } : {}),
        ...(symbol.lastTime !== undefined ? { lastTime: symbol.lastTime } : {}),
        ...(symbol.firstClose !== undefined ? { firstClose: symbol.firstClose } : {}),
        ...(symbol.lastClose !== undefined ? { lastClose: symbol.lastClose } : {}),
        ...(symbol.directionalLookbackClose !== undefined ? { directionalLookbackClose: symbol.directionalLookbackClose } : {}),
        ...(symbol.directionalLookbackBars !== undefined ? { directionalLookbackBars: symbol.directionalLookbackBars } : {}),
        ...(symbol.result ? { result: compactUniverseMetrics(symbol.result) } : {}),
        ...(symbol.error ? { error: symbol.error } : {}),
        ...(symbol.oosResult ? { oosResult: compactUniverseMetrics(symbol.oosResult) } : {}),
        ...(symbol.oosVerdict ? { oosVerdict: symbol.oosVerdict } : {}),
    };
}

function compactUniverseCandidate(candidate: FinderUniverseCandidate): FinderUniverseCandidate {
    return {
        strategyKey: candidate.strategyKey,
        strategyName: candidate.strategyName,
        params: { ...candidate.params },
        symbols: candidate.symbols.slice(0, FINDER_UNIVERSE_SYMBOL_SNAPSHOT_LIMIT).map(compactUniverseSymbol),
        activeSymbols: candidate.activeSymbols,
        profitableSymbols: candidate.profitableSymbols,
        losingSymbols: candidate.losingSymbols,
        flatSymbols: candidate.flatSymbols,
        noTradeSymbols: candidate.noTradeSymbols,
        totalTrades: candidate.totalTrades,
        profitableActiveRatio: candidate.profitableActiveRatio,
        medianExpectancy: candidate.medianExpectancy,
        medianSharpe: candidate.medianSharpe,
        medianSharpeAvailable: candidate.medianSharpeAvailable,
        medianProfitFactor: candidate.medianProfitFactor,
        medianNetProfit: candidate.medianNetProfit,
        worstNetProfit: candidate.worstNetProfit,
        bestNetProfit: candidate.bestNetProfit,
        medianCompositeEdgeRatio: candidate.medianCompositeEdgeRatio,
        ...(Number.isFinite(candidate.medianExitAlpha) ? { medianExitAlpha: candidate.medianExitAlpha } : {}),
        ...(Number.isFinite(candidate.medianOosExitAlpha) ? { medianOosExitAlpha: candidate.medianOosExitAlpha } : {}),
        drawdownMetricsAvailable: candidate.drawdownMetricsAvailable === true,
        worstMaxDrawdownPercent: Number.isFinite(candidate.worstMaxDrawdownPercent) ? candidate.worstMaxDrawdownPercent : 0,
        medianMaxDrawdownPercent: Number.isFinite(candidate.medianMaxDrawdownPercent) ? candidate.medianMaxDrawdownPercent : 0,
        medianReturnDrawdownRatio: Number.isFinite(candidate.medianReturnDrawdownRatio) ? candidate.medianReturnDrawdownRatio : 0,
        robustUniverseScore: candidate.robustUniverseScore,
        windowStabilityScore: candidate.windowStabilityScore,
        ...(candidate.evaluationStoppedEarly !== undefined ? { evaluationStoppedEarly: candidate.evaluationStoppedEarly } : {}),
        ...(candidate.stoppedReason ? { stoppedReason: candidate.stoppedReason } : {}),
        ...(candidate.exitStrategyKey ? { exitStrategyKey: candidate.exitStrategyKey } : {}),
        ...(candidate.exitStrategyName ? { exitStrategyName: candidate.exitStrategyName } : {}),
        ...(candidate.exitStrategyParams ? { exitStrategyParams: { ...candidate.exitStrategyParams } } : {}),
        ...(candidate.oosAggregate ? { oosAggregate: { ...candidate.oosAggregate } } : {}),
    };
}

function compactAssetOpportunityResult(result: FinderAssetOpportunityResult): FinderAssetOpportunityResult {
    return {
        symbol: result.symbol,
        strategyKey: result.strategyKey,
        strategyName: result.strategyName,
        params: { ...(result.params as StrategyParams) },
        ...(result.exitStrategyKey ? { exitStrategyKey: result.exitStrategyKey } : {}),
        ...(result.exitStrategyName ? { exitStrategyName: result.exitStrategyName } : {}),
        ...(result.exitStrategyParams ? { exitStrategyParams: { ...(result.exitStrategyParams as StrategyParams) } } : {}),
        historicalRank: result.historicalRank,
        totalCandidatesEvaluated: result.totalCandidatesEvaluated,
        isHistoricalBest: result.isHistoricalBest,
        freshStatus: result.freshStatus,
        direction: result.direction,
        latestSignalTime: result.latestSignalTime,
        signalAgeBars: result.signalAgeBars,
        fillTiming: result.fillTiming,
        selectionResult: compactBacktestResult(result.selectionResult),
        ...(result.oosResult ? { oosResult: compactBacktestResult(result.oosResult) } : {}),
        ...(result.oosVerdict ? { oosVerdict: result.oosVerdict } : {}),
        ...(result.oosHorizonMetrics
            ? {
                oosHorizonMetrics: {
                    ignoreLastBars: result.oosHorizonMetrics.ignoreLastBars,
                    horizons: result.oosHorizonMetrics.horizons.map((horizon) => ({ ...horizon })),
                },
            }
            : {}),
        ...(result.oosNextExitMetrics
            ? {
                oosNextExitMetrics: { ...result.oosNextExitMetrics },
            }
            : {}),
        support: { ...result.support },
        grade: result.grade,
    };
}

function compactStrategyQualityResult(result: FinderStrategyQualityResult): FinderStrategyQualityResult {
    return {
        ...result,
        params: { ...result.params },
        symbols: result.symbols.slice(0, FINDER_UNIVERSE_SYMBOL_SNAPSHOT_LIMIT).map((symbol) => ({
            ...symbol,
            ...(symbol.result ? { result: { ...symbol.result } } : {}),
            ...(symbol.oosResult ? { oosResult: { ...symbol.oosResult } } : {}),
        })),
        ...(result.oos ? { oos: { ...result.oos } } : {}),
    };
}

export function compactFinderLatestResults(results: FinderLatestResults): FinderLatestResults {
    if (results.scope === "symbol_universe") {
        return {
            scope: "symbol_universe",
            results: results.results
                .slice(0, FINDER_RESULT_SNAPSHOT_LIMIT)
                .map(compactUniverseCandidate),
        };
    }

    if (results.scope === "asset_opportunity") {
        return {
            scope: "asset_opportunity",
            results: results.results
                .slice(0, FINDER_RESULT_SNAPSHOT_LIMIT)
                .map(compactAssetOpportunityResult),
        };
    }

    if (results.scope === "strategy_quality") {
        return {
            scope: "strategy_quality",
            results: results.results
                .slice(0, FINDER_RESULT_SNAPSHOT_LIMIT)
                .map(compactStrategyQualityResult),
        };
    }

    return {
        scope: "current_chart",
        results: results.results
            .slice(0, FINDER_RESULT_SNAPSHOT_LIMIT)
            .map(compactFinderResult),
    };
}

export function normalizeFinderLatestResultsSnapshot(value: unknown): FinderLatestResults | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const candidate = value as Partial<FinderLatestResults>;
    if (
        candidate.scope !== "current_chart"
        && candidate.scope !== "symbol_universe"
        && candidate.scope !== "asset_opportunity"
        && candidate.scope !== "strategy_quality"
    ) {
        return null;
    }
    if (!Array.isArray(candidate.results)) {
        return null;
    }
    return compactFinderLatestResults(candidate as FinderLatestResults);
}
