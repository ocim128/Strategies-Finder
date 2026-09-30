import type {
    FinderArmPerformanceCandidate,
    FinderArmPerformanceRunContext,
    FinderAssetOpportunityResult,
    FinderLatestResults,
    FinderResult,
    FinderStrategyQualityResult,
    FinderUniverseCandidate,
    FinderUniverseSymbolMetrics,
    FinderUniverseSymbolResult,
} from "../types/finder";
import type { BacktestResult, StrategyParams } from "../types/strategies";
import {
    compactFinderArmPerformanceMetric,
    FINDER_ARM_PERFORMANCE_REPLAY_FIELDS,
    type FinderArmPerformanceArm,
} from "./finder-arm-performance-metrics";

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
        averageWinRate: candidate.averageWinRate,
        tradeWeightedWinRate: candidate.tradeWeightedWinRate,
        winReliabilityQ25: candidate.winReliabilityQ25,
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
        ...(result.eodOpenTradePnl !== undefined ? { eodOpenTradePnl: result.eodOpenTradePnl } : {}),
        ...(result.oosResult ? { oosResult: compactBacktestResult(result.oosResult) } : {}),
        ...(result.oosVerdict ? { oosVerdict: result.oosVerdict } : {}),
        ...(result.oosHorizonMetrics
            ? {
                oosHorizonMetrics: {
                    ignoreLastBars: result.oosHorizonMetrics.ignoreLastBars,
                    ...(result.oosHorizonMetrics.basis
                        ? { basis: result.oosHorizonMetrics.basis }
                        : {}),
                    horizons: result.oosHorizonMetrics.horizons.map((horizon) => ({ ...horizon })),
                },
            }
            : {}),
        ...(result.activePositionContinuationMetrics
            ? {
                activePositionContinuationMetrics: {
                    ignoreLastBars: result.activePositionContinuationMetrics.ignoreLastBars,
                    ...(result.activePositionContinuationMetrics.basis
                        ? { basis: result.activePositionContinuationMetrics.basis }
                        : {}),
                    horizons: result.activePositionContinuationMetrics.horizons.map((horizon) => ({ ...horizon })),
                },
            }
            : {}),
        ...(result.oosNextExitMetrics
            ? {
                oosNextExitMetrics: { ...result.oosNextExitMetrics },
            }
            : {}),
        ...(result.medianBarsToTp !== undefined ? { medianBarsToTp: result.medianBarsToTp } : {}),
        ...(result.priorTupleRecurrenceCount !== undefined ? { priorTupleRecurrenceCount: result.priorTupleRecurrenceCount } : {}),
        ...(result.strategyCoverageCount !== undefined ? { strategyCoverageCount: result.strategyCoverageCount } : {}),
        ...(result.barrierExitShare !== undefined ? { barrierExitShare: result.barrierExitShare } : {}),
        ...(result.entryHourConcentration !== undefined ? { entryHourConcentration: result.entryHourConcentration } : {}),
        ...(result.tradeGapUniformity !== undefined ? { tradeGapUniformity: result.tradeGapUniformity } : {}),
        ...(result.topDecileProfitShare !== undefined ? { topDecileProfitShare: result.topDecileProfitShare } : {}),
        ...(result.winnerLoserHoldGapBars !== undefined ? { winnerLoserHoldGapBars: result.winnerLoserHoldGapBars } : {}),
        ...(result.entryPriceRegimeMembership !== undefined ? { entryPriceRegimeMembership: result.entryPriceRegimeMembership } : {}),
        ...(result.equityPathLinearity !== undefined ? { equityPathLinearity: result.equityPathLinearity } : {}),
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

function compactArmPerformanceCandidate(candidate: FinderArmPerformanceCandidate): FinderArmPerformanceCandidate {
    const common = {
        candidateId: candidate.candidateId,
        candidateOrdinal: candidate.candidateOrdinal,
        strategyKey: candidate.strategyKey,
        strategyName: candidate.strategyName,
        params: { ...candidate.params },
        backtestSettings: { ...candidate.backtestSettings },
        requestedEngineMode: candidate.requestedEngineMode,
        actualEngineMode: candidate.actualEngineMode,
        ...(candidate.exitStrategyParams ? { exitStrategyParams: { ...candidate.exitStrategyParams } } : {}),
        ...(candidate.exitStrategyKey ? { exitStrategyKey: candidate.exitStrategyKey } : {}),
        ...(candidate.exitStrategyName ? { exitStrategyName: candidate.exitStrategyName } : {}),
        pairCoverage: { ...candidate.pairCoverage },
    };
    if (candidate.replayMode === "asset_switch") {
        return {
            ...common,
            replayMode: "asset_switch",
            assetSwitchMetrics: Object.fromEntries(
                Object.entries(candidate.assetSwitchMetrics).map(([arm, metric]) => [arm, {
                    ...metric,
                    diagnosticCounts: { ...metric.diagnosticCounts },
                    openPosition: metric.openPosition ? { ...metric.openPosition } : null,
                    pendingOrder: metric.pendingOrder ? { ...metric.pendingOrder } : null,
                }]),
            ) as NonNullable<FinderArmPerformanceCandidate["assetSwitchMetrics"]>,
        };
    }
    return {
        ...common,
        replayMode: "horizon",
        horizon: candidate.horizon,
        metrics: Object.fromEntries(
            Object.keys(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS).map((arm) => {
                const metric = candidate.metrics[arm as FinderArmPerformanceArm];
                return [arm, metric ? compactFinderArmPerformanceMetric(metric) : undefined];
            }).filter(([, metric]) => metric !== undefined),
        ) as NonNullable<FinderArmPerformanceCandidate["metrics"]>,
        ...(candidate.metricsExTopContributor ? {
            metricsExTopContributor: Object.fromEntries(
                Object.keys(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS).map((arm) => {
                    const metric = candidate.metricsExTopContributor?.[arm as FinderArmPerformanceArm];
                    return [arm, metric ? compactFinderArmPerformanceMetric(metric) : undefined];
                }).filter(([, metric]) => metric !== undefined),
            ) as FinderArmPerformanceCandidate["metricsExTopContributor"],
        } : {}),
        ...(candidate.contributorExclusions ? {
            contributorExclusions: Object.fromEntries(
                Object.entries(candidate.contributorExclusions).map(([arm, exclusion]) => [arm, {
                    asset: exclusion?.asset ?? null,
                    events: Math.max(0, Math.floor(exclusion?.events ?? 0)),
                }]),
            ) as FinderArmPerformanceCandidate["contributorExclusions"],
        } : {}),
    };
}

function compactArmPerformanceContext(
    context: FinderArmPerformanceRunContext | null,
): FinderArmPerformanceRunContext | null {
    if (!context) return null;
    return {
        ...context,
        strategyKeys: [...context.strategyKeys],
        pairs: [...context.pairs],
        searchOptions: { ...context.searchOptions },
        backtestSettings: { ...context.backtestSettings },
        capitalSettings: { ...context.capitalSettings },
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

    if (results.scope === "arm_performance") {
        return {
            scope: "arm_performance",
            results: results.results
                .slice(0, FINDER_RESULT_SNAPSHOT_LIMIT)
                .map(compactArmPerformanceCandidate),
            runContext: compactArmPerformanceContext(results.runContext),
            // A localStorage snapshot is only a preview. The server terminal
            // inventory remains authoritative for full-inventory Re-Sort.
            inventoryComplete: false,
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
        && candidate.scope !== "arm_performance"
    ) {
        return null;
    }
    if (!Array.isArray(candidate.results)) {
        return null;
    }
    if (candidate.scope === "arm_performance") {
        const rows = candidate.results as unknown[];
        const rawContext = candidate.runContext && typeof candidate.runContext === "object"
            ? candidate.runContext as unknown as Record<string, unknown>
            : null;
        const contextMode = rawContext?.replayMode;
        if (contextMode !== undefined && contextMode !== "horizon" && contextMode !== "asset_switch") return null;
        const normalizedRows: FinderArmPerformanceCandidate[] = [];
        let rowsMode: "horizon" | "asset_switch" | undefined;
        const valid = rows.every((row) => {
            if (!row || typeof row !== "object" || Array.isArray(row)) return false;
            const item = row as Record<string, unknown>;
            if (typeof item.candidateId !== "string" || !Number.isInteger(item.candidateOrdinal)) return false;
            const replayMode = item.replayMode === undefined ? "horizon" : item.replayMode;
            if (replayMode !== "horizon" && replayMode !== "asset_switch") return false;
            if (rowsMode !== undefined && rowsMode !== replayMode) return false;
            rowsMode = replayMode;
            if (contextMode && replayMode !== contextMode) return false;
            if (replayMode === "asset_switch") {
                if (!item.assetSwitchMetrics || typeof item.assetSwitchMetrics !== "object" || Array.isArray(item.assetSwitchMetrics)) return false;
                const switchMetrics = item.assetSwitchMetrics as Record<string, unknown>;
                const complete = Object.keys(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS).every((arm) => {
                    const metric = switchMetrics[arm] as Record<string, unknown> | undefined;
                    return !!metric && typeof metric === "object"
                        && (metric.status === "complete" || metric.status === "no_entry" || metric.status === "incomplete")
                        && Number.isInteger(metric.enteredCount)
                        && Number.isInteger(metric.completedTrades);
                });
                if (!complete) return false;
                normalizedRows.push({ ...item, replayMode: "asset_switch" } as unknown as FinderArmPerformanceCandidate);
                return true;
            }
            if (!item.metrics || typeof item.metrics !== "object" || Array.isArray(item.metrics)) return false;
            const metrics = item.metrics as Record<string, unknown>;
            const metricsValid = Object.keys(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS).every((arm) => {
                const metric = metrics[arm];
                return metric !== null && typeof metric === "object" && !Array.isArray(metric);
            });
            if (!metricsValid || !Number.isInteger(item.horizon)) return false;
            normalizedRows.push({ ...item, replayMode: "horizon" } as unknown as FinderArmPerformanceCandidate);
            return true;
        });
        if (!valid) return null;
        return compactFinderLatestResults({
            scope: "arm_performance",
            results: normalizedRows,
            runContext: rawContext
                ? { ...rawContext, replayMode: contextMode ?? "horizon" } as unknown as FinderArmPerformanceRunContext
                : null,
            inventoryComplete: false,
        });
    }
    return compactFinderLatestResults(candidate as FinderLatestResults);
}
