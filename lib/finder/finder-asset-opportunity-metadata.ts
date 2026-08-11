import type { FinderAssetOpportunityResult } from "../types/finder";
import type { BacktestResult } from "../types/strategies";

/**
 * Pretty-print payload for one Asset Opportunity top result. Shared by the
 * browser Copy Top Results clipboard action.
 * Browser/server-safe: reads no DOM, state, or
 * registry — the caller resolves the strategy metadata and interval.
 */
export interface AssetOpportunityMetadataPayload {
    scope: "asset_opportunity";
    rank: number;
    symbol: string;
    strategyId: string;
    strategyName: string;
    interval: string;
    params: FinderAssetOpportunityResult["params"];
    metadata: unknown;
    direction: FinderAssetOpportunityResult["direction"];
    freshStatus: FinderAssetOpportunityResult["freshStatus"];
    latestSignalTime: FinderAssetOpportunityResult["latestSignalTime"];
    signalAgeBars: number;
    fillTiming: FinderAssetOpportunityResult["fillTiming"];
    historicalRank: number;
    totalCandidatesEvaluated: number;
    selectionMetrics: FinderAssetOpportunityResult["selectionResult"];
    support: FinderAssetOpportunityResult["support"];
    grade: FinderAssetOpportunityResult["grade"];
    oos: {
        metrics: NonNullable<FinderAssetOpportunityResult["oosResult"]>;
        verdict: NonNullable<FinderAssetOpportunityResult["oosVerdict"]>;
    } | null;
    oosHorizonMetrics: FinderAssetOpportunityResult["oosHorizonMetrics"] | null;
    exitStrategy: {
        key: string;
        name: string | null;
        params: FinderAssetOpportunityResult["exitStrategyParams"] | {};
    } | null;
}

export function buildAssetOpportunityMetadataPayload(args: {
    result: FinderAssetOpportunityResult;
    rank: number;
    interval: string;
    strategyMetadata: unknown;
}): AssetOpportunityMetadataPayload {
    const { result, rank, interval, strategyMetadata } = args;
    return {
        scope: "asset_opportunity",
        rank,
        symbol: result.symbol,
        strategyId: result.strategyKey,
        strategyName: result.strategyName,
        interval,
        params: result.params,
        metadata: strategyMetadata ?? null,
        direction: result.direction,
        freshStatus: result.freshStatus,
        latestSignalTime: result.latestSignalTime,
        signalAgeBars: result.signalAgeBars,
        fillTiming: result.fillTiming,
        historicalRank: result.historicalRank,
        totalCandidatesEvaluated: result.totalCandidatesEvaluated,
        selectionMetrics: result.selectionResult,
        support: result.support,
        grade: result.grade,
        oos: result.oosResult && result.oosVerdict
            ? { metrics: result.oosResult, verdict: result.oosVerdict }
            : null,
        oosHorizonMetrics: result.oosHorizonMetrics ?? null,
        exitStrategy: result.exitStrategyKey
            ? {
                key: result.exitStrategyKey,
                name: result.exitStrategyName ?? null,
                params: result.exitStrategyParams ?? {},
            }
            : null,
    };
}

/** Performance-only row used by the automatic server-side archive. */
export type AssetOpportunityPerformanceMetrics = Pick<BacktestResult,
    | "netProfit"
    | "netProfitPercent"
    | "winRate"
    | "expectancy"
    | "avgTrade"
    | "profitFactor"
    | "maxDrawdown"
    | "maxDrawdownPercent"
    | "totalTrades"
    | "winningTrades"
    | "losingTrades"
    | "avgWin"
    | "avgLoss"
    | "sharpeRatio"
>;

export interface AssetOpportunityPerformancePayload {
    scope: "asset_opportunity";
    rank: number;
    symbol: string;
    strategyId: string;
    strategyName: string;
    selectionPerformance: AssetOpportunityPerformanceMetrics;
    oosPerformance: {
        verdict: NonNullable<FinderAssetOpportunityResult["oosVerdict"]>;
        metrics: AssetOpportunityPerformanceMetrics;
    } | null;
    forwardOosPerformance: FinderAssetOpportunityResult["oosHorizonMetrics"] | null;
}

function selectAssetOpportunityPerformanceMetrics(
    result: BacktestResult,
): AssetOpportunityPerformanceMetrics {
    return {
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
    };
}

/** Build the compact performance-only payload used by automatic archive blocks. */
export function buildAssetOpportunityPerformancePayload(args: {
    result: FinderAssetOpportunityResult;
    rank: number;
}): AssetOpportunityPerformancePayload {
    const { result, rank } = args;
    return {
        scope: "asset_opportunity",
        rank,
        symbol: result.symbol,
        strategyId: result.strategyKey,
        strategyName: result.strategyName,
        selectionPerformance: selectAssetOpportunityPerformanceMetrics(result.selectionResult),
        oosPerformance: result.oosResult && result.oosVerdict
            ? {
                verdict: result.oosVerdict,
                metrics: selectAssetOpportunityPerformanceMetrics(result.oosResult),
            }
            : null,
        forwardOosPerformance: result.oosHorizonMetrics ?? null,
    };
}
