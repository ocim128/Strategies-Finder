import type { FinderAssetOpportunityResult } from "../types/finder";
import type { BacktestResult } from "../types/strategies";
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
    /** Optional because older persisted snapshots predate these metrics. */
    medianBarsToTp?: FinderAssetOpportunityResult["medianBarsToTp"];
    priorTupleRecurrenceCount?: FinderAssetOpportunityResult["priorTupleRecurrenceCount"];
    strategyCoverageCount?: FinderAssetOpportunityResult["strategyCoverageCount"];
    barrierExitShare?: FinderAssetOpportunityResult["barrierExitShare"];
    entryHourConcentration?: FinderAssetOpportunityResult["entryHourConcentration"];
    tradeGapUniformity?: FinderAssetOpportunityResult["tradeGapUniformity"];
    topDecileProfitShare?: FinderAssetOpportunityResult["topDecileProfitShare"];
    winnerLoserHoldGapBars?: FinderAssetOpportunityResult["winnerLoserHoldGapBars"];
    entryPriceRegimeMembership?: FinderAssetOpportunityResult["entryPriceRegimeMembership"];
    equityPathLinearity?: FinderAssetOpportunityResult["equityPathLinearity"];
    support: FinderAssetOpportunityResult["support"];
    grade: FinderAssetOpportunityResult["grade"];
    oos: {
        metrics: NonNullable<FinderAssetOpportunityResult["oosResult"]>;
        verdict: NonNullable<FinderAssetOpportunityResult["oosVerdict"]>;
    } | null;
    oosHorizonMetrics: FinderAssetOpportunityResult["oosHorizonMetrics"] | null;
    oosNextExitMetrics: FinderAssetOpportunityResult["oosNextExitMetrics"] | null;
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
        support: result.support,
        grade: result.grade,
        oos: result.oosResult && result.oosVerdict
            ? { metrics: result.oosResult, verdict: result.oosVerdict }
            : null,
        oosHorizonMetrics: result.oosHorizonMetrics ?? null,
        oosNextExitMetrics: result.oosNextExitMetrics ?? null,
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
> & {
    /** Optional for compatibility with archives written before this sort. */
    medianBarsToTp?: number | null;
    priorTupleRecurrenceCount?: number | null;
    barrierExitShare?: number | null;
    entryHourConcentration?: number | null;
    tradeGapUniformity?: number | null;
    topDecileProfitShare?: number | null;
    winnerLoserHoldGapBars?: number | null;
    entryPriceRegimeMembership?: number | null;
    equityPathLinearity?: number | null;
};

export interface AssetOpportunityPerformancePayload {
    scope: "asset_opportunity";
    rank: number;
    symbol: string;
    strategyId: string;
    strategyName: string;
    /** Stable identity for the sampled entry/exit parameters. */
    candidateFingerprint: string;
    /** Present on fresh-signal-library resort representatives. */
    freshSignalLibraryCount?: number | null;
    /** Exact per-run P90-capped trade-count value used by that resort. */
    totalTradesCappedValue?: number | null;
    /** Present on the grouped strategy-coverage resort representative. */
    strategyCoverageCount?: number | null;
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
    nextExitOosPerformance: FinderAssetOpportunityResult["oosNextExitMetrics"] | null;
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

export interface AssetOpportunityNextExitOosBaseline {
    eligibleCandidateCount: number;
    observedExits: number;
    censoredResults: number;
    unavailableResults: number;
    averagePnlPercent: number | null;
    exitReasonCounts: Record<string, number>;
    unavailableReasonCounts: Record<string, number>;
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
    derived?: Pick<FinderAssetOpportunityResult,
        | "medianBarsToTp"
        | "priorTupleRecurrenceCount"
        | "barrierExitShare"
        | "entryHourConcentration"
        | "tradeGapUniformity"
        | "topDecileProfitShare"
        | "winnerLoserHoldGapBars"
        | "entryPriceRegimeMembership"
        | "equityPathLinearity"
    >,
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
        ...(derived?.medianBarsToTp !== undefined ? { medianBarsToTp: derived.medianBarsToTp } : {}),
        ...(derived?.priorTupleRecurrenceCount !== undefined ? { priorTupleRecurrenceCount: derived.priorTupleRecurrenceCount } : {}),
        ...(derived?.barrierExitShare !== undefined ? { barrierExitShare: derived.barrierExitShare } : {}),
        ...(derived?.entryHourConcentration !== undefined ? { entryHourConcentration: derived.entryHourConcentration } : {}),
        ...(derived?.tradeGapUniformity !== undefined ? { tradeGapUniformity: derived.tradeGapUniformity } : {}),
        ...(derived?.topDecileProfitShare !== undefined ? { topDecileProfitShare: derived.topDecileProfitShare } : {}),
        ...(derived?.winnerLoserHoldGapBars !== undefined ? { winnerLoserHoldGapBars: derived.winnerLoserHoldGapBars } : {}),
        ...(derived?.entryPriceRegimeMembership !== undefined ? { entryPriceRegimeMembership: derived.entryPriceRegimeMembership } : {}),
        ...(derived?.equityPathLinearity !== undefined ? { equityPathLinearity: derived.equityPathLinearity } : {}),
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
        ...(result.freshSignalLibraryCount !== undefined ? { freshSignalLibraryCount: result.freshSignalLibraryCount } : {}),
        ...(result.totalTradesCappedValue !== undefined ? { totalTradesCappedValue: result.totalTradesCappedValue } : {}),
        ...(result.strategyCoverageCount !== undefined ? { strategyCoverageCount: result.strategyCoverageCount } : {}),
        signalCandleHourUtc: hours.utc,
        signalCandleHourJakarta: hours.jakarta,
        selectionPerformance: selectAssetOpportunityPerformanceMetrics(
            result.selectionResult,
            result,
        ),
        oosPerformance: result.oosResult && result.oosVerdict
            ? {
                verdict: result.oosVerdict,
                metrics: selectAssetOpportunityPerformanceMetrics(result.oosResult),
            }
            : null,
        forwardOosPerformance: result.oosHorizonMetrics ?? null,
        nextExitOosPerformance: result.oosNextExitMetrics ?? null,
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

export function buildAssetOpportunityNextExitOosBaseline(
    results: FinderAssetOpportunityResult[],
): AssetOpportunityNextExitOosBaseline | null {
    const exitReasonCounts: Record<string, number> = {};
    let observedExits = 0;
    let censoredResults = 0;
    let unavailableResults = 0;
    let pnlTotal = 0;
    let pnlSamples = 0;
    const unavailableReasonCounts: Record<string, number> = {};
    for (const result of results) {
        const metrics = result.oosNextExitMetrics;
        if (!metrics) continue;
        if (metrics.status === "exited") observedExits += 1;
        else if (metrics.status === "censored") censoredResults += 1;
        else {
            unavailableResults += 1;
            const reason = metrics.unavailableReason ?? "unknown_legacy";
            unavailableReasonCounts[reason] = (unavailableReasonCounts[reason] ?? 0) + 1;
        }
        if (metrics.pnlPercent !== null && Number.isFinite(metrics.pnlPercent)) {
            pnlTotal += metrics.pnlPercent;
            pnlSamples += 1;
        }
        if (metrics.exitReason) {
            exitReasonCounts[metrics.exitReason] = (exitReasonCounts[metrics.exitReason] ?? 0) + 1;
        }
    }
    if (observedExits + censoredResults + unavailableResults === 0) return null;
    return {
        eligibleCandidateCount: results.length,
        observedExits,
        censoredResults,
        unavailableResults,
        averagePnlPercent: pnlSamples > 0 ? pnlTotal / pnlSamples : null,
        exitReasonCounts,
        unavailableReasonCounts,
    };
}
