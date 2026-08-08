/**
 * Support counts, decision grading, and ranking comparator for the Finder Asset
 * Opportunity scope.
 *
 * Pure leaf module: no I/O, no DOM, no async. Given the per-asset pool of
 * fresh/active candidates and the explicit decision gates from the
 * implementation plan, computes the support counts, the decision grade, and a
 * deterministic lexicographic rank.
 *
 * Decision rules (from docs/finder-cross-asset-opportunity-implementation-plan.md):
 *
 * - `reject`: fresh entry exists but historical expectancy is negative or fewer
 *   than the configured minimum historical trades;
 * - `watch`: fresh entry and positive historical expectancy, but insufficient
 *   same-direction top-K support or OOS is inconclusive;
 * - `select`: fresh entry, minimum historical trades met, positive historical
 *   expectancy, same-direction support at least `minFreshSupport`, and OOS pass
 *   when OOS validation is enabled.
 *
 * Asset ranking is lexicographic and transparent:
 *
 * 1. `select` before `watch` before `reject`;
 * 2. best fresh candidate rank, ascending;
 * 3. same-direction support count, descending;
 * 4. historical expectancy, descending;
 * 5. completed trades, descending;
 * 6. symbol, ascending as deterministic tie-breaker.
 *
 * This is an evidence grade, not a probability that the next trade will win.
 */

import type {
    FinderAssetDecisionGrade,
    FinderAssetDirection,
    FinderAssetOpportunityResult,
    FinderAssetSupportCounts,
    FinderMetric,
    FinderOosVerdict,
} from "../types/finder";

/**
 * A single per-asset candidate carried in the bounded top-K pool. The pool is
 * the input to the support + decision computation. `rank` is the historical
 * rank inside the per-asset pool (1-based; 1 is best).
 */
export interface AssetPoolCandidate {
    /** Historical rank inside the per-asset pool (1-based). */
    rank: number;
    /** Resolved fresh-entry status for this candidate. */
    freshStatus: "fresh" | "active" | "flat";
    /** Direction of the latest entry, when known. */
    direction: FinderAssetDirection | null;
    /** True iff the latest trade is still open (exitReason === "end_of_data"). */
    isOpen: boolean;
}

/**
 * Compute the top-K support counts for one asset's bounded candidate pool.
 *
 * - `freshLongCandidates`: fresh candidates whose direction is long.
 * - `freshShortCandidates`: fresh candidates whose direction is short.
 * - `freshSameDirection`: fresh candidates whose direction matches the winner's
 *   direction. When the winner has no direction (no entry), this is 0.
 * - `poolSize`: total candidates carried in the pool.
 * - `bestFreshRank`: best (lowest) historical rank among fresh candidates.
 * - `directionAgreementRatio`: freshSameDirection /
 *   max(1, freshLongCandidates + freshShortCandidates).
 */
export function computeAssetSupportCounts(args: {
    pool: AssetPoolCandidate[];
    winnerDirection: FinderAssetDirection | null;
}): FinderAssetSupportCounts {
    const { pool, winnerDirection } = args;
    let freshLongCandidates = 0;
    let freshShortCandidates = 0;
    let freshSameDirection = 0;
    let bestFreshRank: number | null = null;

    for (const candidate of pool) {
        if (candidate.freshStatus !== "fresh") continue;
        if (candidate.direction === "long") {
            freshLongCandidates += 1;
        } else if (candidate.direction === "short") {
            freshShortCandidates += 1;
        }
        if (winnerDirection !== null && candidate.direction === winnerDirection) {
            freshSameDirection += 1;
        }
        if (bestFreshRank === null || candidate.rank < bestFreshRank) {
            bestFreshRank = candidate.rank;
        }
    }

    const totalFresh = freshLongCandidates + freshShortCandidates;
    return {
        freshLongCandidates,
        freshShortCandidates,
        freshSameDirection,
        poolSize: pool.length,
        bestFreshRank,
        directionAgreementRatio: totalFresh > 0 ? freshSameDirection / totalFresh : 0,
    };
}

/**
 * Inputs to the decision-grading rule.
 */
export interface AssetDecisionInputs {
    /** True iff the winner has a fresh entry on the latest closed candle. */
    hasFreshEntry: boolean;
    /** True iff the winner's historical selectionResult expectancy is positive. */
    hasPositiveExpectancy: boolean;
    /** Winner's historical completed trade count (endpoint-adjusted). */
    historicalTrades: number;
    /** Same-direction top-K support count (freshSameDirection). */
    sameDirectionSupport: number;
    /** Configured minimum historical trades (Finder minTrades). */
    minHistoricalTrades: number;
    /** Configured minimum same-direction support for a `select` grade. */
    minFreshSupport: number;
    /** OOS verdict, when OOS validation is enabled. Undefined when off. */
    oosVerdict?: FinderOosVerdict | undefined;
}

/**
 * Decide the asset grade using the explicit gates. An evidence grade, not a
 * probability that the next trade will win.
 *
 * Rules (in evaluation order):
 *
 * 1. No fresh entry → not a candidate (caller excludes from rows). Returns
 *    `reject` defensively; the caller should not display rows where the grade
 *    was computed without a fresh entry.
 * 2. Negative expectancy or fewer than `minHistoricalTrades` → `reject`.
 * 3. OOS enabled and verdict is `fail` → `reject`.
 * 4. Same-direction support < `minFreshSupport` → `watch`.
 * 5. OOS enabled and verdict is `inconclusive` → `watch`.
 * 6. Otherwise → `select`.
 */
export function decideAssetGrade(input: AssetDecisionInputs): FinderAssetDecisionGrade {
    if (!input.hasFreshEntry) return "reject";
    if (!input.hasPositiveExpectancy) return "reject";
    if (input.historicalTrades < input.minHistoricalTrades) return "reject";
    if (input.oosVerdict === "fail") return "reject";
    if (input.sameDirectionSupport < input.minFreshSupport) return "watch";
    if (input.oosVerdict === "inconclusive") return "watch";
    return "select";
}

const GRADE_ORDER: Record<FinderAssetDecisionGrade, number> = {
    select: 0,
    watch: 1,
    reject: 2,
};

/**
 * Deterministic lexicographic comparator for asset results.
 *
 * Order:
 * 1. `select` before `watch` before `reject`.
 * 2. best fresh candidate rank, ascending (null rank sorts last).
 * 3. same-direction support count, descending.
 * 4. historical expectancy, descending.
 * 5. completed trades, descending.
 * 6. symbol, ascending as deterministic tie-breaker.
 *
 * Returns negative when `a` should sort before `b`.
 */
export function compareAssetOpportunityResults(
    a: FinderAssetOpportunityResult,
    b: FinderAssetOpportunityResult,
): number {
    const gradeA = GRADE_ORDER[a.grade];
    const gradeB = GRADE_ORDER[b.grade];
    if (gradeA !== gradeB) return gradeA - gradeB;

    const rankA = a.support.bestFreshRank ?? Number.POSITIVE_INFINITY;
    const rankB = b.support.bestFreshRank ?? Number.POSITIVE_INFINITY;
    if (rankA !== rankB) return rankA - rankB;

    if (a.support.freshSameDirection !== b.support.freshSameDirection) {
        return b.support.freshSameDirection - a.support.freshSameDirection;
    }

    const expA = Number.isFinite(a.selectionResult.expectancy) ? a.selectionResult.expectancy : 0;
    const expB = Number.isFinite(b.selectionResult.expectancy) ? b.selectionResult.expectancy : 0;
    if (expA !== expB) return expB - expA;

    const tradesA = a.selectionResult.totalTrades;
    const tradesB = b.selectionResult.totalTrades;
    if (tradesA !== tradesB) return tradesB - tradesA;

    if (a.symbol < b.symbol) return -1;
    if (a.symbol > b.symbol) return 1;
    return 0;
}

/**
 * Sort a list of asset opportunity results in place using the lexicographic
 * comparator. Returns the same array for convenience.
 */
export function sortAssetOpportunityResults(results: FinderAssetOpportunityResult[]): FinderAssetOpportunityResult[] {
    results.sort(compareAssetOpportunityResults);
    return results;
}

/**
 * Metrics the post-run re-sort can rank Asset Opportunity results by. These
 * map directly to scalar fields on `selectionResult: BacktestResult` and are
 * always populated for every retained result.
 */
const ASSET_RESORT_METRICS: readonly FinderMetric[] = [
    "expectancy",
    "netProfit",
    "netProfitPercent",
    "profitFactor",
    "sharpeRatio",
    "winRate",
    "maxDrawdownPercent",
    "averageGain",
    "totalTrades",
];

export function getAssetOpportunityResortMetrics(): readonly FinderMetric[] {
    return ASSET_RESORT_METRICS;
}

/**
 * Resolve a metric value from an Asset Opportunity result's `selectionResult`.
 * Returns `0` for missing/NaN values and bounded sentinels for infinities so
 * the sort never breaks on non-finite analytics.
 * `maxDrawdownPercent` is returned as-is (smaller is better); the caller
 * handles the ascending direction.
 */
function getAssetOpportunityMetricValue(
    result: FinderAssetOpportunityResult,
    metric: FinderMetric,
): number {
    const sel = result.selectionResult;
    const analytics = sel.performanceAnalytics;
    const analyticsValue = (value: number | undefined): number => {
        if (value === undefined || Number.isNaN(value)) return 0;
        if (!Number.isFinite(value)) return value > 0 ? Number.MAX_SAFE_INTEGER : -Number.MAX_SAFE_INTEGER;
        return value;
    };
    switch (metric) {
        case "netProfit": return Number.isFinite(sel.netProfit) ? sel.netProfit : 0;
        case "netProfitPercent": return Number.isFinite(sel.netProfitPercent) ? sel.netProfitPercent : 0;
        case "profitFactor": return Number.isFinite(sel.profitFactor) ? sel.profitFactor : 0;
        case "sharpeRatio": return Number.isFinite(sel.sharpeRatio) ? sel.sharpeRatio : 0;
        case "winRate": return Number.isFinite(sel.winRate) ? sel.winRate : 0;
        case "maxDrawdownPercent": return Number.isFinite(sel.maxDrawdownPercent) ? sel.maxDrawdownPercent : 0;
        case "sortinoRatio": return analyticsValue(analytics?.sortinoRatio);
        case "calmarRatio": return analyticsValue(analytics?.calmarRatio);
        case "tailRatio": return analyticsValue(analytics?.tailRatio);
        case "skewness": return analyticsValue(analytics?.skewness);
        case "ulcerIndex": return analyticsValue(analytics?.ulcerIndex);
        case "serenityIndex": return analyticsValue(analytics?.serenityIndex);
        case "valueAtRisk95": return analyticsValue(analytics?.valueAtRisk95);
        case "conditionalValueAtRisk95": return analyticsValue(analytics?.conditionalValueAtRisk95);
        case "expectancy": return Number.isFinite(sel.expectancy) ? sel.expectancy : 0;
        case "averageGain": return Number.isFinite(sel.avgWin) ? sel.avgWin : 0;
        case "totalTrades": return sel.totalTrades ?? 0;
        default: return 0;
    }
}

/**
 * Sort a copy of Asset Opportunity results by a single metric for the post-run
 * re-sort dropdown. When `metric` is null, falls back to the existing
 * grade-first lexicographic comparator (the run-time default).
 *
 * Returns a NEW array — does not mutate the input.
 */
export function sortAssetOpportunityResultsByMetric(
    results: readonly FinderAssetOpportunityResult[],
    metric: FinderMetric | null,
): FinderAssetOpportunityResult[] {
    if (metric === null) {
        return sortAssetOpportunityResults([...results]);
    }
    const ascending = metric === "maxDrawdownPercent"
        || metric === "ulcerIndex"
        || metric === "valueAtRisk95"
        || metric === "conditionalValueAtRisk95";
    return [...results].sort((a, b) => {
        const valA = getAssetOpportunityMetricValue(a, metric);
        const valB = getAssetOpportunityMetricValue(b, metric);
        if (valA !== valB) return ascending ? valA - valB : valB - valA;
        // Deterministic tie-breaker.
        if (a.symbol < b.symbol) return -1;
        if (a.symbol > b.symbol) return 1;
        return 0;
    });
}
