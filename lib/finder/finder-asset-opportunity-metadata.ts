import type { FinderAssetOpportunityResult } from "../types/finder";
import type { BacktestResult, BacktestScalarMetrics } from "../types/strategies";
import { fnv1a64Hex } from "../batch-backtest/max-active-research-contract";
import { stableStringify } from "../json-utils";
import { parseTimeToUnixSeconds } from "../time-normalization";
import type {
    FinderAssetOosHorizonBasis,
    FinderAssetOosMetrics,
} from "./finder-asset-opportunity-oos";

/** All price bases the fixed-horizon pass can measure; keys absent when that basis had no usable data. */
export type AssetOpportunityForwardOosByBasis = Partial<Record<FinderAssetOosHorizonBasis, FinderAssetOosMetrics>>;

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
    eodOpenTradePnl?: FinderAssetOpportunityResult["eodOpenTradePnl"];
    /** Optional because older persisted snapshots predate these metrics. */
    medianBarsToTp?: FinderAssetOpportunityResult["medianBarsToTp"];
    priorTupleRecurrenceCount?: FinderAssetOpportunityResult["priorTupleRecurrenceCount"];
    strategyCoverageCount?: FinderAssetOpportunityResult["strategyCoverageCount"];
    consensusRankWeight?: FinderAssetOpportunityResult["consensusRankWeight"];
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
    activePositionContinuationMetrics: FinderAssetOpportunityResult["activePositionContinuationMetrics"] | null;
    oosNextExitMetrics: FinderAssetOpportunityResult["oosNextExitMetrics"] | null;
    exitStrategy: {
        key: string;
        name: string | null;
        params: FinderAssetOpportunityResult["exitStrategyParams"] | {};
    } | null;
}

/**
 * Optional diagnostic metrics carried on `FinderAssetOpportunityResult`. The
 * archive metadata payload and the snapshot compaction both embed these
 * (omitting undefined entries, in this exact key order), so they are built
 * here once to keep the two wire shapes from drifting apart.
 */
export function compactOptionalOpportunityDiagnostics(result: FinderAssetOpportunityResult) {
    return {
        ...(result.medianBarsToTp !== undefined ? { medianBarsToTp: result.medianBarsToTp } : {}),
        ...(result.priorTupleRecurrenceCount !== undefined ? { priorTupleRecurrenceCount: result.priorTupleRecurrenceCount } : {}),
        ...(result.strategyCoverageCount !== undefined ? { strategyCoverageCount: result.strategyCoverageCount } : {}),
        ...(result.consensusRankWeight !== undefined ? { consensusRankWeight: result.consensusRankWeight } : {}),
        ...(result.barrierExitShare !== undefined ? { barrierExitShare: result.barrierExitShare } : {}),
        ...(result.entryHourConcentration !== undefined ? { entryHourConcentration: result.entryHourConcentration } : {}),
        ...(result.tradeGapUniformity !== undefined ? { tradeGapUniformity: result.tradeGapUniformity } : {}),
        ...(result.topDecileProfitShare !== undefined ? { topDecileProfitShare: result.topDecileProfitShare } : {}),
        ...(result.winnerLoserHoldGapBars !== undefined ? { winnerLoserHoldGapBars: result.winnerLoserHoldGapBars } : {}),
        ...(result.entryPriceRegimeMembership !== undefined ? { entryPriceRegimeMembership: result.entryPriceRegimeMembership } : {}),
        ...(result.equityPathLinearity !== undefined ? { equityPathLinearity: result.equityPathLinearity } : {}),
    };
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
        ...(result.eodOpenTradePnl !== undefined ? { eodOpenTradePnl: result.eodOpenTradePnl } : {}),
        ...compactOptionalOpportunityDiagnostics(result),
        support: result.support,
        grade: result.grade,
        oos: result.oosResult && result.oosVerdict
            ? { metrics: result.oosResult, verdict: result.oosVerdict }
            : null,
        oosHorizonMetrics: result.oosHorizonMetrics ?? null,
        activePositionContinuationMetrics: result.activePositionContinuationMetrics ?? null,
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
export type AssetOpportunityPerformanceMetrics = BacktestScalarMetrics & {
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
    /** Symbol-level consensus rank points; null on symbols that failed the coverage floor. */
    consensusRankWeight?: number | null;
    /** Hour of the latest signal candle; null for date-only/no signal times. */
    signalCandleHourUtc: number | null;
    /** Hour of the latest signal candle in the app's Asia/Jakarta display zone. */
    signalCandleHourJakarta: number | null;
    selectionPerformance: AssetOpportunityPerformanceMetrics;
    oosPerformance: {
        verdict: NonNullable<FinderAssetOpportunityResult["oosVerdict"]>;
        metrics: AssetOpportunityPerformanceMetrics;
    } | null;
    /** OPEN EOD rows store boundary-close continuation here so archive ranking uses one forward outcome field. */
    forwardOosPerformance: FinderAssetOpportunityResult["oosHorizonMetrics"] | null;
    /**
     * All price bases measured in the same pass (fresh entry preferred, OPEN
     * continuation as fallback per basis); absent on rows that measured only
     * the selected basis, which keeps single-basis archives parseable.
     */
    forwardOosPerformanceByBasis?: AssetOpportunityForwardOosByBasis;
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

/**
 * One selection scalar's distribution over the retained candidate pool.
 * `count` counts only rows with a finite value; percentiles are `null`
 * (never `NaN`) when nothing is available.
 */
export interface AssetOpportunityPoolScalarDistribution {
    /** Rows with a finite value for this scalar. */
    count: number;
    p10: number | null;
    p25: number | null;
    p50: number | null;
    p75: number | null;
    p90: number | null;
}

/**
 * One fixed horizon's distribution over the pool. `averagePnlPercent` equals
 * the baseline mean on the same input; the percentiles add the robust
 * location/tail view the baseline cannot express.
 */
export interface AssetOpportunityPoolDistributionHorizon {
    bars: number;
    observedResults: number;
    totalSamples: number;
    /** Equals {@link AssetOpportunityForwardOosBaselineHorizon.averagePnlPercent} for this horizon. */
    averagePnlPercent: number | null;
    p10: number | null;
    p25: number | null;
    p50: number | null;
    p75: number | null;
    p90: number | null;
}

/**
 * Pool-level distribution persisted in every new archive block. Summarizes
 * the retained candidate pool (the Candidate Pool setting) — the same
 * population the all-candidate baseline aggregates — so offline analysis can
 * compare picks against the pool distribution. Scalar summaries only; no
 * heavy arrays ever reach the archive.
 */
export interface AssetOpportunityPoolDistribution {
    eligibleCandidateCount: number;
    /** Primary (pair-basis) fixed-horizon distribution, same eligibility as the baseline. */
    horizons: AssetOpportunityPoolDistributionHorizon[];
    /** Present only when rows carry per-basis forward measurements. */
    horizonsByBasis?: Partial<Record<FinderAssetOosHorizonBasis, AssetOpportunityPoolDistributionHorizon[]>>;
    /** Selection-scalar distribution over the pool, frozen key set. */
    selection: Record<string, AssetOpportunityPoolScalarDistribution>;
}

/** Frozen percentile fractions used by every archive pool distribution. */
export const ASSET_OPPORTUNITY_POOL_PERCENTILE_FRACTIONS = [0.1, 0.25, 0.5, 0.75, 0.9] as const;

/**
 * Frozen selection-scalar key set for the pool distribution: exactly the
 * `BacktestScalarMetrics` keys `selectAssetOpportunityPerformanceMetrics`
 * persists on `AssetOpportunityPerformancePayload.selectionPerformance`.
 * Do not invent new keys here — reconcile against that function first.
 */
export const ASSET_OPPORTUNITY_POOL_SELECTION_METRIC_KEYS = [
    "netProfit",
    "netProfitPercent",
    "winRate",
    "expectancy",
    "avgTrade",
    "profitFactor",
    "maxDrawdown",
    "maxDrawdownPercent",
    "totalTrades",
    "winningTrades",
    "losingTrades",
    "avgWin",
    "avgLoss",
    "sharpeRatio",
] as const;

export type AssetOpportunityPoolSelectionMetricKey = typeof ASSET_OPPORTUNITY_POOL_SELECTION_METRIC_KEYS[number];

/**
 * Nearest-rank percentile, reimplemented from the `percentile` helper in
 * `scripts/lib/asset-opportunity-analysis.ts` (sorted copy, index
 * `Math.round((n - 1) * fraction)`). `lib/` must not import from `scripts/`,
 * so the two implementations share the method by contract, pinned by a
 * parity test. Returns `null` for an empty or non-finite input — never `NaN`.
 */
export function assetOpportunityNearestRankPercentile(
    values: readonly number[],
    fraction: number,
): number | null {
    if (values.length === 0 || !Number.isFinite(fraction)) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
    return sorted[index]!;
}

export interface AssetOpportunityPoolDistributionBuildOptions {
    /**
     * Include fixed-horizon percentiles (default). Pass `false` to persist
     * selection scalars only — the next-exit measurement mode keeps its
     * count-based baseline and ships no horizon distribution.
     */
    includeHorizons?: boolean;
}

interface ForwardHorizonSample {
    pnl: number;
    sampleSize: number;
}

/**
 * Shared forward-horizon sample collection: ONE row/horizon filtering code
 * path feeding both the mean baseline and the pool distribution, so their
 * eligibility can never drift.
 */
function collectForwardHorizonSamples(
    results: readonly FinderAssetOpportunityResult[],
    basis?: FinderAssetOosHorizonBasis,
): Map<number, ForwardHorizonSample[]> {
    // With a basis, aggregate that basis's measurements so baseline deltas
    // never compare a selected top-K basis outcome against a mixed-basis pool.
    const metricsFor = (result: FinderAssetOpportunityResult): FinderAssetOosMetrics | null | undefined =>
        basis
            ? result.oosHorizonMetricsByBasis?.[basis] ?? result.activePositionContinuationMetricsByBasis?.[basis]
            : result.oosHorizonMetrics ?? result.activePositionContinuationMetrics;
    const samples = new Map<number, ForwardHorizonSample[]>();
    for (const result of results) {
        for (const horizon of metricsFor(result)?.horizons ?? []) {
            const averagePnlPercent = horizon.averagePnlPercent;
            if (averagePnlPercent === null || !Number.isFinite(averagePnlPercent) || horizon.sampleSize < 1) continue;
            const bucket = samples.get(horizon.bars) ?? [];
            bucket.push({ pnl: averagePnlPercent, sampleSize: horizon.sampleSize });
            samples.set(horizon.bars, bucket);
        }
    }
    return samples;
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

const assetOpportunityCandidateFingerprintCache = new WeakMap<
    FinderAssetOpportunityResult,
    string
>();

/**
 * Stable identity for one sampled candidate. This is a reproducibility key,
 * not a security hash; it lets archive analysis distinguish parameter changes
 * from the same symbol/strategy appearing again.
 */
export function buildAssetOpportunityCandidateFingerprint(
    result: FinderAssetOpportunityResult,
): string {
    const cached = assetOpportunityCandidateFingerprintCache.get(result);
    if (cached !== undefined) return cached;

    const fingerprint = fnv1a64Hex(stableStringify({
        strategyId: result.strategyKey,
        params: result.params,
        exitStrategyKey: result.exitStrategyKey ?? null,
        exitStrategyParams: result.exitStrategyParams ?? null,
    }));
    assetOpportunityCandidateFingerprintCache.set(result, fingerprint);
    return fingerprint;
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

/**
 * Per-basis merge of the two fixed-horizon measurement surfaces: fresh-entry
 * metrics preferred per basis, OPEN-position continuation as that basis's
 * fallback — mirroring the single `forwardOosPerformance` field. Returns
 * undefined when no per-basis measurement exists (single-basis/legacy rows).
 */
export function mergeForwardOosByBasis(
    result: FinderAssetOpportunityResult,
): AssetOpportunityForwardOosByBasis | undefined {
    const byBasis: AssetOpportunityForwardOosByBasis = {};
    for (const [basis, metrics] of Object.entries(result.oosHorizonMetricsByBasis ?? {})) {
        if (metrics) byBasis[basis as FinderAssetOosHorizonBasis] = metrics;
    }
    for (const [basis, metrics] of Object.entries(result.activePositionContinuationMetricsByBasis ?? {})) {
        const key = basis as FinderAssetOosHorizonBasis;
        if (metrics && !byBasis[key]) byBasis[key] = metrics;
    }
    return Object.keys(byBasis).length > 0 ? byBasis : undefined;
}

/** Build the compact performance-only payload used by automatic archive blocks. */
export function buildAssetOpportunityPerformancePayload(args: {
    result: FinderAssetOpportunityResult;
    rank: number;
}): AssetOpportunityPerformancePayload {
    const { result, rank } = args;
    const hours = signalCandleHours(result.latestSignalTime);
    const forwardOosPerformanceByBasis = mergeForwardOosByBasis(result);
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
        ...(result.consensusRankWeight !== undefined ? { consensusRankWeight: result.consensusRankWeight } : {}),
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
        forwardOosPerformance: result.oosHorizonMetrics
            ?? result.activePositionContinuationMetrics
            ?? null,
        ...(forwardOosPerformanceByBasis ? { forwardOosPerformanceByBasis } : {}),
        nextExitOosPerformance: result.oosNextExitMetrics ?? null,
    };
}

/** Build an all-result baseline before the archive's top-N sort slice. */
export function buildAssetOpportunityForwardOosBaseline(
    results: FinderAssetOpportunityResult[],
    basis?: FinderAssetOosHorizonBasis,
): AssetOpportunityForwardOosBaseline {
    const aggregates = collectForwardHorizonSamples(results, basis);
    return {
        eligibleCandidateCount: results.length,
        horizons: [...aggregates.entries()]
            .sort(([left], [right]) => left - right)
            .map(([bars, samples]) => {
                const sum = samples.reduce((total, sample) => total + sample.pnl, 0);
                const weightedSum = samples.reduce((total, sample) => total + sample.pnl * sample.sampleSize, 0);
                return {
                    bars,
                    averagePnlPercent: samples.length > 0 ? sum / samples.length : null,
                    sampleWeightedAveragePnlPercent: samples.reduce((total, sample) => total + sample.sampleSize, 0) > 0
                        ? weightedSum / samples.reduce((total, sample) => total + sample.sampleSize, 0)
                        : null,
                    positiveResults: samples.filter((sample) => sample.pnl > 0).length,
                    observedResults: samples.length,
                    totalSamples: samples.reduce((total, sample) => total + sample.sampleSize, 0),
                };
            }),
    };
}

/**
 * Per-basis all-result baselines for one iteration, built only for bases with
 * at least one measurement; null when no per-basis data exists (single-basis
 * runs and older results keep using the unscoped baseline).
 */
export function buildAssetOpportunityForwardOosBaselinesByBasis(
    results: FinderAssetOpportunityResult[],
): Partial<Record<FinderAssetOosHorizonBasis, AssetOpportunityForwardOosBaseline>> | null {
    const byBasis: Partial<Record<FinderAssetOosHorizonBasis, AssetOpportunityForwardOosBaseline>> = {};
    for (const basis of ["pair", "base_only", "quote_only"] as const) {
        if (!results.some((result) => mergeForwardOosByBasis(result)?.[basis])) continue;
        byBasis[basis] = buildAssetOpportunityForwardOosBaseline(results, basis);
    }
    return Object.keys(byBasis).length > 0 ? byBasis : null;
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

function buildAssetOpportunityPoolScalarDistribution(
    values: readonly number[],
): AssetOpportunityPoolScalarDistribution {
    const percentiles: Record<string, number | null> = {};
    for (const fraction of ASSET_OPPORTUNITY_POOL_PERCENTILE_FRACTIONS) {
        percentiles[`p${Math.round(fraction * 100)}`] = assetOpportunityNearestRankPercentile(values, fraction);
    }
    return {
        count: values.length,
        p10: percentiles["p10"] ?? null,
        p25: percentiles["p25"] ?? null,
        p50: percentiles["p50"] ?? null,
        p75: percentiles["p75"] ?? null,
        p90: percentiles["p90"] ?? null,
    };
}

function buildAssetOpportunityPoolHorizonDistribution(
    bars: number,
    samples: readonly ForwardHorizonSample[],
): AssetOpportunityPoolDistributionHorizon {
    const pnlValues = samples.map((sample) => sample.pnl);
    const percentiles: Record<string, number | null> = {};
    for (const fraction of ASSET_OPPORTUNITY_POOL_PERCENTILE_FRACTIONS) {
        percentiles[`p${Math.round(fraction * 100)}`] = assetOpportunityNearestRankPercentile(pnlValues, fraction);
    }
    return {
        bars,
        observedResults: samples.length,
        totalSamples: samples.reduce((total, sample) => total + sample.sampleSize, 0),
        averagePnlPercent: samples.length > 0
            ? pnlValues.reduce((sum, value) => sum + value, 0) / pnlValues.length
            : null,
        p10: percentiles["p10"] ?? null,
        p25: percentiles["p25"] ?? null,
        p50: percentiles["p50"] ?? null,
        p75: percentiles["p75"] ?? null,
        p90: percentiles["p90"] ?? null,
    };
}

/**
 * Pool distribution for one iteration's unchanged result set. Horizon
 * eligibility is the baseline's (shared {@link collectForwardHorizonSamples}
 * path), so `averagePnlPercent` equals the baseline mean on the same input;
 * selection-scalar percentiles are measurement-mode independent and always
 * computed. Pure function: no mutation, deterministic output, `null` (never
 * `NaN`) for unavailable values.
 */
export function buildAssetOpportunityPoolDistribution(
    results: readonly FinderAssetOpportunityResult[],
    basis?: FinderAssetOosHorizonBasis,
    options: AssetOpportunityPoolDistributionBuildOptions = {},
): AssetOpportunityPoolDistribution {
    const includeHorizons = options.includeHorizons ?? true;
    const selection: Record<string, AssetOpportunityPoolScalarDistribution> = {};
    for (const key of ASSET_OPPORTUNITY_POOL_SELECTION_METRIC_KEYS) {
        const values: number[] = [];
        for (const result of results) {
            const value = (result.selectionResult as unknown as Record<string, unknown>)[key];
            if (typeof value === "number" && Number.isFinite(value)) values.push(value);
        }
        selection[key] = buildAssetOpportunityPoolScalarDistribution(values);
    }
    if (!includeHorizons) {
        return { eligibleCandidateCount: results.length, horizons: [], selection };
    }
    const horizons = [...collectForwardHorizonSamples(results, basis).entries()]
        .sort(([left], [right]) => left - right)
        .map(([bars, samples]) => buildAssetOpportunityPoolHorizonDistribution(bars, samples));
    const horizonsByBasis: Partial<Record<FinderAssetOosHorizonBasis, AssetOpportunityPoolDistributionHorizon[]>> = {};
    for (const basisKey of ["pair", "base_only", "quote_only"] as const) {
        if (!results.some((result) => mergeForwardOosByBasis(result)?.[basisKey])) continue;
        horizonsByBasis[basisKey] = [...collectForwardHorizonSamples(results, basisKey).entries()]
            .sort(([left], [right]) => left - right)
            .map(([bars, samples]) => buildAssetOpportunityPoolHorizonDistribution(bars, samples));
    }
    return {
        eligibleCandidateCount: results.length,
        horizons,
        ...(Object.keys(horizonsByBasis).length > 0 ? { horizonsByBasis } : {}),
        selection,
    };
}
