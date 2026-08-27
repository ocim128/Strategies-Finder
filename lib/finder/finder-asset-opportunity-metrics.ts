/**
 * Support counts, decision grading, and ranking comparator for the Finder Asset
 * Opportunity scope.
 *
 * Pure leaf module: no I/O, no DOM, no async. Given the per-asset pool of
 * fresh/active candidates and the explicit decision gates from the
 * implementation plan, computes the support counts, the decision grade, and a
 * deterministic lexicographic rank.
 *
 * Decision rules (see docs/finder-server-side.md):
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
import type { BacktestResult, OHLCVData } from "../types/strategies";
import { buildAssetOpportunityCandidateFingerprint } from "./finder-asset-opportunity-metadata";
import { timeKey } from "../strategies/backtest/backtest-utils";

/**
 * Keep displayed Asset Opportunity rows bounded to the submitted asset
 * universe. This is also used when adopting a terminal server snapshot after
 * a stream reconnect, where an older browser result must never leak into the
 * new run.
 */
export function retainAssetOpportunityResultsForSymbols(
    results: readonly FinderAssetOpportunityResult[],
    symbols: Iterable<string>,
): FinderAssetOpportunityResult[] {
    const allowed = new Set<string>();
    for (const symbol of symbols) {
        const normalized = symbol.trim().toUpperCase();
        if (normalized) allowed.add(normalized);
    }
    return results.filter((result) => allowed.has(result.symbol.trim().toUpperCase()));
}

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
 * Keep the first row for each normalized pair symbol. Callers should provide
 * rows in the desired order first, so the retained row is that pair's
 * representative for the current ranking.
 */
export function deduplicateAssetOpportunityResultsBySymbol(
    results: readonly FinderAssetOpportunityResult[],
): FinderAssetOpportunityResult[] {
    const seenSymbols = new Set<string>();
    return results.filter((result) => {
        const symbol = result.symbol.trim().toUpperCase();
        if (!symbol) return true;
        if (seenSymbols.has(symbol)) return false;
        seenSymbols.add(symbol);
        return true;
    });
}

/**
 * Metrics the post-run re-sort can rank Asset Opportunity results by. Most
 * map directly to scalar fields on `selectionResult: BacktestResult`; the
 * consensus metric is derived across strategy-level rows for each symbol.
 */
export const FRESH_SIGNAL_LIBRARIES_METRIC = "freshSignalLibraries" as const;
/**
 * Consensus variant: fresh-signal-library count (same as `freshSignalLibraries`),
 * but count ties are broken by totalTrades (highest first) instead of the
 * grade-first lexicographic order. Surfaces the most-traded consensus names
 * when several symbols share the same library count. The per-symbol
 * representative is the grade-winner (as in `freshSignalLibraries`), so the
 * totalTrades tiebreak is that winner's, not the symbol's max.
 */
export const FRESH_SIGNAL_LIBRARIES_BY_TRADES_METRIC = "freshSignalLibrariesByTrades" as const;
/**
 * Percentile-saturated trade count: rank by
 * `min(totalTrades, P90 of this result set's trade counts)` descending. The
 * cap is computed per sort call so it auto-fits the run config — a fixed cap
 * is meaningless across configs (maxholdbars=1 runs produce 500-1300 trades,
 * 12-bar-hold runs ~50-150; a fixed 100 saturates everything on the former
 * and degenerates the sort into its tiebreak). Only the hyper-active elite
 * saturates at the cap; once there, extra trades stop improving rank so a
 * dominant high-trade-count asset/strategy can no longer lock the top spot.
 * Ties at the cap are broken by averageGain (descending — larger average
 * win). netProfitPercent and expectancy are intentionally NOT consulted so
 * the metric stays count-based.
 */
export const TOTAL_TRADES_CAPPED_METRIC = "totalTradesCapped" as const;
/** Saturation percentile (0-1) for {@link TOTAL_TRADES_CAPPED_METRIC}. */
export const TOTAL_TRADES_SATURATION_PERCENTILE = 0.9;
/**
 * Statistical significance of the per-trade edge: expectancy * sqrt(trades) / sd,
 * with sd approximated from the binary win/loss mixture (winRate, avgWin, avgLoss).
 * Ranks by SIGNIFICANCE, not size — the search optimizes size metrics, so
 * size-sorted tops are overfit extremes by construction; t-stat instead rewards a
 * modest edge proven over many trades. Sample-size guarding is owned by the RUN's
 * minimum-trade filter, not by this sort. An all-win candidate (zero observed
 * variance) with positive expectancy maps to +Infinity and ranks first — the same
 * convention payoffRatio uses for all-win candidates.
 */
export const T_STAT_EDGE_METRIC = "tstatEdge" as const;
/**
 * Median candle distance from entry to an in-sample take-profit exit. A
 * minimum of three qualifying trades is fixed by the research idea.
 */
export const MEDIAN_BARS_TO_TP_METRIC = "medianBarsToTp" as const;
export const MEDIAN_BARS_TO_TP_MIN_HITS = 3;
/**
 * Inverted (worst-first) archive sorts: rank by the base metric ASCENDING so the
 * top slot is the WORST candidate (e.g. most negative netProfit). Research purpose:
 * test whether in-search FAILURE carries forward information (fade candidates) —
 * the offline union-pool probe can only see "best of the worst"; the full-pool
 * archive blocks expose the true bottom of the candidate list. The run-level
 * minimum-trade filter guards the top against degenerate 1-2 trade candidates;
 * these sorts deliberately apply no extra floor.
 */
export const INVERTED_NET_PROFIT_METRIC = "invertedNetProfit" as const;
export const INVERTED_EXPECTANCY_METRIC = "invertedExpectancy" as const;
export const INVERTED_AVERAGE_GAIN_METRIC = "invertedAverageGain" as const;
export const INVERTED_WIN_RATE_METRIC = "invertedWinRate" as const;
export const INVERTED_SHARPE_RATIO_METRIC = "invertedSharpeRatio" as const;
export const INVERTED_PROFIT_FACTOR_METRIC = "invertedProfitFactor" as const;
/**
 * Worst-first by drawdown: the base maxDrawdownPercent sort is already ascending
 * (smallest DD best), so its inversion is DESCENDING — largest drawdown first.
 */
export const INVERTED_MAX_DRAWDOWN_METRIC = "invertedMaxDrawdownPercent" as const;
export type FinderAssetOpportunityResortMetric =
    | FinderMetric
    | typeof FRESH_SIGNAL_LIBRARIES_METRIC
    | typeof FRESH_SIGNAL_LIBRARIES_BY_TRADES_METRIC
    | typeof TOTAL_TRADES_CAPPED_METRIC
    | typeof T_STAT_EDGE_METRIC
    | typeof MEDIAN_BARS_TO_TP_METRIC
    | typeof INVERTED_NET_PROFIT_METRIC
    | typeof INVERTED_EXPECTANCY_METRIC
    | typeof INVERTED_AVERAGE_GAIN_METRIC
    | typeof INVERTED_WIN_RATE_METRIC
    | typeof INVERTED_SHARPE_RATIO_METRIC
    | typeof INVERTED_PROFIT_FACTOR_METRIC
    | typeof INVERTED_MAX_DRAWDOWN_METRIC;
/** Special batch-only choice that archives the default order plus every metric. */
export const ASSET_OPPORTUNITY_ALL_SORTS = "allAssetOpportunitySorts" as const;
export type FinderAssetOpportunityArchiveSort =
    | FinderAssetOpportunityResortMetric
    | typeof ASSET_OPPORTUNITY_ALL_SORTS;

const ASSET_RESORT_METRICS: readonly FinderAssetOpportunityResortMetric[] = [
    "expectancy",
    "netProfit",
    "netProfitPercent",
    "profitFactor",
    "sharpeRatio",
    "winRate",
    "maxDrawdownPercent",
    "averageGain",
    "payoffRatio",
    "totalTrades",
    FRESH_SIGNAL_LIBRARIES_METRIC,
    FRESH_SIGNAL_LIBRARIES_BY_TRADES_METRIC,
    TOTAL_TRADES_CAPPED_METRIC,
    T_STAT_EDGE_METRIC,
    MEDIAN_BARS_TO_TP_METRIC,
    INVERTED_NET_PROFIT_METRIC,
    INVERTED_EXPECTANCY_METRIC,
    INVERTED_AVERAGE_GAIN_METRIC,
    INVERTED_WIN_RATE_METRIC,
    INVERTED_SHARPE_RATIO_METRIC,
    INVERTED_PROFIT_FACTOR_METRIC,
    INVERTED_MAX_DRAWDOWN_METRIC,
];

export function getAssetOpportunityResortMetrics(): readonly FinderAssetOpportunityResortMetric[] {
    return ASSET_RESORT_METRICS;
}

/**
 * Calculate the row-level in-sample median bars to take profit. Trade times
 * are mapped to the exact candles used for the selection result, so this
 * remains a bar-count metric across all supported time representations.
 */
export function calculateMedianBarsToTp(
    result: Pick<BacktestResult, "trades" | "totalTrades">,
    candles: readonly OHLCVData[],
): number | null {
    if (!Number.isFinite(result.totalTrades) || result.totalTrades < MEDIAN_BARS_TO_TP_MIN_HITS) return null;

    const indexByTime = new Map<string, number>();
    for (let index = 0; index < candles.length; index += 1) {
        indexByTime.set(timeKey(candles[index]!.time), index);
    }

    const barsToTakeProfit: number[] = [];
    for (const trade of result.trades) {
        if (trade.exitReason !== "take_profit") continue;
        const entryIndex = indexByTime.get(timeKey(trade.entryTime));
        const exitIndex = indexByTime.get(timeKey(trade.exitTime));
        if (entryIndex === undefined || exitIndex === undefined) return null;
        const bars = exitIndex - entryIndex;
        if (!Number.isFinite(bars) || bars < 0) return null;
        barsToTakeProfit.push(bars);
    }

    if (barsToTakeProfit.length < MEDIAN_BARS_TO_TP_MIN_HITS) return null;
    barsToTakeProfit.sort((a, b) => a - b);
    const middle = Math.floor(barsToTakeProfit.length / 2);
    return barsToTakeProfit.length % 2 === 1
        ? barsToTakeProfit[middle]!
        : (barsToTakeProfit[middle - 1]! + barsToTakeProfit[middle]!) / 2;
}

/** Linear-interpolated quantile of an ascending-sorted number array. */
function quantileSorted(sortedAsc: readonly number[], q: number): number {
    if (sortedAsc.length === 0) return 0;
    const position = (sortedAsc.length - 1) * q;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return sortedAsc[lower]!;
    return sortedAsc[lower]! + (sortedAsc[upper]! - sortedAsc[lower]!) * (position - lower);
}

function getFreshSignalLibraryCounts(
    results: readonly FinderAssetOpportunityResult[],
): Map<string, number> {
    const librariesBySymbol = new Map<string, Set<string>>();
    for (const result of results) {
        if (result.freshStatus !== "fresh") continue;
        const symbol = result.symbol.trim().toUpperCase();
        const strategyKey = result.strategyKey.trim();
        if (!symbol || !strategyKey) continue;
        const libraries = librariesBySymbol.get(symbol) ?? new Set<string>();
        libraries.add(strategyKey);
        librariesBySymbol.set(symbol, libraries);
    }
    return new Map([...librariesBySymbol.entries()].map(([symbol, libraries]) => [symbol, libraries.size]));
}

/**
 * Resolve a metric value from an Asset Opportunity result's `selectionResult`.
 * Returns `0` for missing/non-finite values so the sort never breaks on NaN.
 * `maxDrawdownPercent` is returned as-is (smaller is better); the caller
 * handles the ascending direction.
 */
function getAssetOpportunityMetricValue(
    result: FinderAssetOpportunityResult,
    metric: FinderMetric,
): number {
    const sel = result.selectionResult;
    switch (metric) {
        case "netProfit": return Number.isFinite(sel.netProfit) ? sel.netProfit : 0;
        case "netProfitPercent": return Number.isFinite(sel.netProfitPercent) ? sel.netProfitPercent : 0;
        case "profitFactor": {
            if (Number.isFinite(sel.profitFactor)) return sel.profitFactor;
            // All-win candidate (no losses => null PF) with positive net maps to
            // +Infinity (payoffRatio precedent). As 0 it would wrongly top the
            // inverted (worst-first) sort; as +Infinity it ranks correctly in
            // BOTH directions.
            return sel.netProfit > 0 ? Number.POSITIVE_INFINITY : 0;
        }
        case "sharpeRatio": return Number.isFinite(sel.sharpeRatio) ? sel.sharpeRatio : 0;
        case "winRate": return Number.isFinite(sel.winRate) ? sel.winRate : 0;
        case "maxDrawdownPercent": return Number.isFinite(sel.maxDrawdownPercent) ? sel.maxDrawdownPercent : 0;
        case "expectancy": return Number.isFinite(sel.expectancy) ? sel.expectancy : 0;
        case "averageGain": return Number.isFinite(sel.avgWin) ? sel.avgWin : 0;
        case "payoffRatio": {
            // avgWin / avgLoss. An all-win candidate (avgLoss = 0) maps to
            // +Infinity so it ranks above every finite payoff (the comparator
            // never computes Inf - Inf because the !== guard short-circuits).
            if (sel.avgLoss > 0) return sel.avgWin / sel.avgLoss;
            return sel.avgWin > 0 ? Number.POSITIVE_INFINITY : 0;
        }
        case "totalTrades": return sel.totalTrades ?? 0;
        default: return 0;
    }
}

/**
 * t-stat of the per-trade edge from the binary win/loss mixture. Returns 0 for
 * missing fields or fewer than 2 trades; a positive-expectancy all-win candidate
 * (zero observed variance) maps to +Infinity (payoffRatio precedent).
 */
function getTStatEdgeValue(result: FinderAssetOpportunityResult): number {
    const sel = result.selectionResult;
    const mean = sel.expectancy;
    const trades = sel.totalTrades ?? 0;
    const winRate = sel.winRate;
    const avgWin = sel.avgWin;
    const avgLoss = sel.avgLoss;
    if (!Number.isFinite(mean) || !Number.isFinite(winRate) || !Number.isFinite(avgWin) || !Number.isFinite(avgLoss) || trades < 2) {
        return 0;
    }
    const winProbability = Math.min(1, Math.max(0, winRate / 100));
    const variance = winProbability * (avgWin - mean) ** 2 + (1 - winProbability) * (avgLoss + mean) ** 2;
    if (variance <= 0) return mean > 0 ? Number.POSITIVE_INFINITY : 0;
    return (mean * Math.sqrt(trades)) / Math.sqrt(variance);
}

/**
 * Sort a copy of Asset Opportunity results by a single metric for the post-run
 * re-sort dropdown. When `metric` is null, falls back to the existing
 * grade-first lexicographic comparator (the run-time default).
 *
 * Metric ties fall back to realized performance scalars (expectancy, then
 * netProfitPercent, then totalTrades) before the deterministic symbol order.
 * This matters when the metric saturates at its optimum across many candidates
 * — e.g. small `maxHoldBars` producing many never-drew-down backtests that
 * share `maxDrawdownPercent = 0`, or sharpe values that collapse to a common
 * figure — so the top-N is a performance slice rather than an alphabetical one.
 * Grade is intentionally NOT consulted as a tiebreak; a metric re-sort
 * overrides grade by design.
 *
 * Returns a NEW array — does not mutate the input.
 */
export function sortAssetOpportunityResultsByMetric(
    results: readonly FinderAssetOpportunityResult[],
    metric: FinderAssetOpportunityResortMetric | null,
): FinderAssetOpportunityResult[] {
    if (metric === null) {
        return sortAssetOpportunityResults([...results]);
    }
    if (metric === FRESH_SIGNAL_LIBRARIES_METRIC || metric === FRESH_SIGNAL_LIBRARIES_BY_TRADES_METRIC) {
        const counts = getFreshSignalLibraryCounts(results);
        const representatives = new Map<string, FinderAssetOpportunityResult>();
        for (const result of results) {
            const symbol = result.symbol.trim().toUpperCase();
            if (!symbol) continue;
            const current = representatives.get(symbol);
            if (!current || compareAssetOpportunityResults(result, current) < 0) {
                representatives.set(symbol, result);
            }
        }
        return [...representatives.values()]
            .map((result) => ({
                ...result,
                freshSignalLibraryCount: counts.get(result.symbol.trim().toUpperCase()) ?? 0,
            }))
            .sort((a, b) => {
                const countA = a.freshSignalLibraryCount ?? 0;
                const countB = b.freshSignalLibraryCount ?? 0;
                if (countA !== countB) return countB - countA;
                if (metric === FRESH_SIGNAL_LIBRARIES_BY_TRADES_METRIC) {
                    // Count tie: prefer the symbol whose winning candidate has
                    // the most historical trades (more statistical weight).
                    const tradesA = a.selectionResult.totalTrades ?? 0;
                    const tradesB = b.selectionResult.totalTrades ?? 0;
                    if (tradesA !== tradesB) return tradesB - tradesA;
                } else {
                    const comparison = compareAssetOpportunityResults(a, b);
                    if (comparison !== 0) return comparison;
                }
                return a.symbol.localeCompare(b.symbol);
            });
    }
    if (metric === TOTAL_TRADES_CAPPED_METRIC) {
        // Percentile saturation: cap = P90 of totalTrades within this result
        // set (auto-fits the run config; a fixed cap saturates everything on
        // maxholdbars=1 runs and degenerates into the tiebreak). Rank by
        // min(trades, cap) descending; the saturated elite ties at the cap and
        // is contested by averageGain (larger average win), then symbol.
        // netProfitPercent and expectancy are deliberately NOT consulted.
        const tradeCounts = results
            .map((result) => getAssetOpportunityMetricValue(result, "totalTrades"))
            .sort((left, right) => left - right);
        if (tradeCounts.length === 0) return [...results];
        const saturationCap = quantileSorted(tradeCounts, TOTAL_TRADES_SATURATION_PERCENTILE);
        return [...results].sort((a, b) => {
            const capA = Math.min(getAssetOpportunityMetricValue(a, "totalTrades"), saturationCap);
            const capB = Math.min(getAssetOpportunityMetricValue(b, "totalTrades"), saturationCap);
            if (capA !== capB) return capB - capA;
            const gainA = getAssetOpportunityMetricValue(a, "averageGain");
            const gainB = getAssetOpportunityMetricValue(b, "averageGain");
            if (gainA !== gainB) return gainB - gainA;
            if (a.symbol < b.symbol) return -1;
            if (a.symbol > b.symbol) return 1;
            return 0;
        });
    }
    if (metric === MEDIAN_BARS_TO_TP_METRIC) {
        return [...results].sort((a, b) => {
            const medianA = a.medianBarsToTp;
            const medianB = b.medianBarsToTp;
            const validA = typeof medianA === "number" && Number.isFinite(medianA) && medianA >= 0;
            const validB = typeof medianB === "number" && Number.isFinite(medianB) && medianB >= 0;
            if (validA !== validB) return validA ? -1 : 1;
            if (validA && validB && medianA !== medianB) return medianA - medianB;

            const symbolA = a.symbol.trim().toUpperCase();
            const symbolB = b.symbol.trim().toUpperCase();
            if (symbolA < symbolB) return -1;
            if (symbolA > symbolB) return 1;
            const strategyA = a.strategyKey.trim();
            const strategyB = b.strategyKey.trim();
            if (strategyA < strategyB) return -1;
            if (strategyA > strategyB) return 1;
            const fingerprintA = buildAssetOpportunityCandidateFingerprint(a);
            const fingerprintB = buildAssetOpportunityCandidateFingerprint(b);
            if (fingerprintA < fingerprintB) return -1;
            if (fingerprintA > fingerprintB) return 1;
            return 0;
        });
    }
    const SECONDARY_TIEBREAK_METRICS: readonly FinderMetric[] = ["expectancy", "netProfitPercent", "totalTrades"];
    if (metric === T_STAT_EDGE_METRIC) {
        // Descending by t-stat; ties fall back to the same realized-performance
        // scalars as the generic metric path before the deterministic symbol order.
        return [...results].sort((a, b) => {
            const valA = getTStatEdgeValue(a);
            const valB = getTStatEdgeValue(b);
            if (valA !== valB) return valB - valA;
            for (const secondary of SECONDARY_TIEBREAK_METRICS) {
                const sA = getAssetOpportunityMetricValue(a, secondary);
                const sB = getAssetOpportunityMetricValue(b, secondary);
                if (sA !== sB) return sB - sA;
            }
            if (a.symbol < b.symbol) return -1;
            if (a.symbol > b.symbol) return 1;
            return 0;
        });
    }
    const INVERTED_METRIC_BASE: Partial<Record<FinderAssetOpportunityResortMetric, FinderMetric>> = {
        [INVERTED_NET_PROFIT_METRIC]: "netProfit",
        [INVERTED_EXPECTANCY_METRIC]: "expectancy",
        [INVERTED_AVERAGE_GAIN_METRIC]: "averageGain",
        [INVERTED_WIN_RATE_METRIC]: "winRate",
        [INVERTED_SHARPE_RATIO_METRIC]: "sharpeRatio",
        [INVERTED_PROFIT_FACTOR_METRIC]: "profitFactor",
        [INVERTED_MAX_DRAWDOWN_METRIC]: "maxDrawdownPercent",
    };
    const invertedBase = INVERTED_METRIC_BASE[metric];
    // Safe cast: when metric is one of the inverted keys the lookup above is
    // defined, so the ?? fallback only ever sees a plain FinderMetric.
    const valueMetric = (invertedBase ?? metric) as FinderMetric;
    // Worst-first direction: larger-is-better metrics invert to ascending; the
    // smaller-is-better drawdown metric inverts to descending.
    const ascending = invertedBase !== undefined
        ? invertedBase !== "maxDrawdownPercent"
        : metric === "maxDrawdownPercent";
    return [...results].sort((a, b) => {
        const valA = getAssetOpportunityMetricValue(a, valueMetric);
        const valB = getAssetOpportunityMetricValue(b, valueMetric);
        if (valA !== valB) return ascending ? valA - valB : valB - valA;
        // Metric tie: fall back to realized performance scalars (each
        // larger-is-better) before the deterministic symbol order, so a mass
        // tie at the metric optimum does not collapse the top-N into an
        // alphabetical slice. See the function docstring for full rationale.
        for (const secondary of SECONDARY_TIEBREAK_METRICS) {
            const sA = getAssetOpportunityMetricValue(a, secondary);
            const sB = getAssetOpportunityMetricValue(b, secondary);
            if (sA !== sB) return sB - sA;
        }
        if (a.symbol < b.symbol) return -1;
        if (a.symbol > b.symbol) return 1;
        return 0;
    });
}
