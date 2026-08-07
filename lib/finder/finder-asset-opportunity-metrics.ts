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
