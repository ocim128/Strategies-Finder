import type { FinderAssetOpportunityResult } from "../types/finder";
import type { BacktestResult, OHLCVData } from "../types/strategies";
import { fnv1a64Hex } from "../batch-backtest/max-active-research-contract";
import { stableStringify } from "../json-utils";
import { parseTimeToUnixSeconds } from "../time-normalization";

const ASIA_JAKARTA_TIMEZONE = "Asia/Jakarta";

/**
 * Reusable hour formatter. `Intl.DateTimeFormat` construction is expensive
 * (it loads locale data per instance); the archive path formats every top row
 * per holdout per sort metric (up to ~110k rows on an All-Sorts batch), so a
 * single module-level instance avoids re-creating the formatter per row.
 */
const JAKARTA_HOUR_FORMATTER = new Intl.DateTimeFormat("en-US", {
    timeZone: ASIA_JAKARTA_TIMEZONE,
    hour: "2-digit",
    hourCycle: "h23",
});

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
    /** Stable identity for the sampled entry/exit parameters. */
    candidateFingerprint: string;
    /** Hour of the latest signal candle; null for date-only/no signal times. */
    signalCandleHourUtc: number | null;
    /** Hour of the latest signal candle in the app's Asia/Jakarta display zone. */
    signalCandleHourJakarta: number | null;
    selectionPerformance: AssetOpportunityPerformanceMetrics;
    oosPerformance: {
        verdict: NonNullable<FinderAssetOpportunityResult["oosVerdict"]>;
        metrics: AssetOpportunityPerformanceMetrics;
    } | null;
    forwardOosPerformance: FinderAssetOpportunityResult["oosHorizonMetrics"] | null;
    /**
     * Pair in-sample volatility = stdev of close-to-close log returns of the
     * pair ratio series the search ran on. Null when the series was too short.
     * Enables volatility-matched analysis of selection edges from the durable
     * archive (the Finder writes no batch artifacts, so this scalar is the only
     * durable record of each pair's risk). Per-symbol, identical across a
     * symbol's candidates.
     */
    pairVolatility: number | null;
}

/**
 * Standard deviation of close-to-close log returns of an OHLCV series — a
 * pair-intrinsic risk measure used for volatility-matched controls. Returns
 * null when the series has fewer than 3 valid returns. Pure leaf: shared by
 * the Asset Opportunity runner (attaches it to each result) and analysis
 * tooling so the volatility definition cannot drift between them.
 */
export function computePairLogReturnVolatility(data: readonly OHLCVData[]): number | null {
    if (data.length < 3) return null;
    const logReturns: number[] = [];
    for (let i = 1; i < data.length; i += 1) {
        const prev = data[i - 1]!.close;
        const cur = data[i]!.close;
        if (prev > 0 && cur > 0) logReturns.push(Math.log(cur / prev));
    }
    if (logReturns.length < 3) return null;
    const mean = logReturns.reduce((sum, value) => sum + value, 0) / logReturns.length;
    const variance = logReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / logReturns.length;
    return Math.sqrt(variance);
}

function signalCandleHours(latestSignalTime: FinderAssetOpportunityResult["latestSignalTime"]): {
    utc: number | null;
    jakarta: number | null;
} {
    if (latestSignalTime === null
        || (typeof latestSignalTime === "string" && /^\d{4}-\d{2}-\d{2}$/.test(latestSignalTime))
        || (typeof latestSignalTime === "object" && latestSignalTime !== null)) {
        return { utc: null, jakarta: null };
    }
    const unixSeconds = parseTimeToUnixSeconds(latestSignalTime);
    if (unixSeconds === null) return { utc: null, jakarta: null };
    const date = new Date(unixSeconds * 1000);
    if (!Number.isFinite(date.getTime())) return { utc: null, jakarta: null };
    const jakartaHour = Number(JAKARTA_HOUR_FORMATTER.format(date));
    return {
        utc: date.getUTCHours(),
        jakarta: Number.isInteger(jakartaHour) && jakartaHour >= 0 && jakartaHour <= 23 ? jakartaHour : null,
    };
}

export interface AssetOpportunityForwardOosBaselineHorizon {
    bars: number;
    averagePnlPercent: number | null;
    sampleWeightedAveragePnlPercent: number | null;
    positiveResults: number;
    observedResults: number;
    totalSamples: number;
}

export interface AssetOpportunityForwardOosBaseline {
    /** Number of all result rows available before the archive top-N slice. */
    eligibleCandidateCount: number;
    horizons: AssetOpportunityForwardOosBaselineHorizon[];
}

/**
 * Stable identity for one sampled candidate. This is a reproducibility key,
 * not a security hash; it lets archive analysis distinguish parameter changes
 * from the same symbol/strategy appearing again.
 */
export function buildAssetOpportunityCandidateFingerprint(
    result: FinderAssetOpportunityResult,
): string {
    return fnv1a64Hex(stableStringify({
        strategyId: result.strategyKey,
        params: result.params,
        exitStrategyKey: result.exitStrategyKey ?? null,
        exitStrategyParams: result.exitStrategyParams ?? null,
    }));
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
    const hours = signalCandleHours(result.latestSignalTime);
    return {
        scope: "asset_opportunity",
        rank,
        symbol: result.symbol,
        strategyId: result.strategyKey,
        strategyName: result.strategyName,
        candidateFingerprint: buildAssetOpportunityCandidateFingerprint(result),
        signalCandleHourUtc: hours.utc,
        signalCandleHourJakarta: hours.jakarta,
        selectionPerformance: selectAssetOpportunityPerformanceMetrics(result.selectionResult),
        oosPerformance: result.oosResult && result.oosVerdict
            ? {
                verdict: result.oosVerdict,
                metrics: selectAssetOpportunityPerformanceMetrics(result.oosResult),
            }
            : null,
        forwardOosPerformance: result.oosHorizonMetrics ?? null,
        pairVolatility: result.pairVolatility ?? null,
    };
}

/** Build an all-result baseline before the archive's top-N sort slice. */
export function buildAssetOpportunityForwardOosBaseline(
    results: FinderAssetOpportunityResult[],
): AssetOpportunityForwardOosBaseline {
    const aggregates = new Map<number, {
        sum: number;
        weightedSum: number;
        positiveResults: number;
        observedResults: number;
        totalSamples: number;
    }>();
    for (const result of results) {
        for (const horizon of result.oosHorizonMetrics?.horizons ?? []) {
            const averagePnlPercent = horizon.averagePnlPercent;
            if (averagePnlPercent === null || !Number.isFinite(averagePnlPercent) || horizon.sampleSize < 1) continue;
            const aggregate = aggregates.get(horizon.bars) ?? {
                sum: 0,
                weightedSum: 0,
                positiveResults: 0,
                observedResults: 0,
                totalSamples: 0,
            };
            aggregate.sum += averagePnlPercent;
            aggregate.weightedSum += averagePnlPercent * horizon.sampleSize;
            aggregate.positiveResults += averagePnlPercent > 0 ? 1 : 0;
            aggregate.observedResults += 1;
            aggregate.totalSamples += horizon.sampleSize;
            aggregates.set(horizon.bars, aggregate);
        }
    }
    return {
        eligibleCandidateCount: results.length,
        horizons: [...aggregates.entries()]
            .sort(([left], [right]) => left - right)
            .map(([bars, aggregate]) => ({
                bars,
                averagePnlPercent: aggregate.observedResults > 0
                    ? aggregate.sum / aggregate.observedResults
                    : null,
                sampleWeightedAveragePnlPercent: aggregate.totalSamples > 0
                    ? aggregate.weightedSum / aggregate.totalSamples
                    : null,
                positiveResults: aggregate.positiveResults,
                observedResults: aggregate.observedResults,
                totalSamples: aggregate.totalSamples,
            })),
    };
}
