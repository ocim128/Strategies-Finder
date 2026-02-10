
import { Trade, TradeSnapshot } from '../../types/index';

// ============================================================================
// Types
// ============================================================================

export interface FeatureStats {
    mean: number;
    median: number;
    stddev: number;
    count: number;
}

export interface FeatureAnalysis {
    /** Key in TradeSnapshot */
    feature: keyof TradeSnapshot;
    /** Human-readable label */
    label: string;
    winStats: FeatureStats;
    lossStats: FeatureStats;
    /** Higher = more discriminating (0-1 range) */
    separationScore: number;
    /** Suggested filter */
    suggestedFilter: { direction: 'above' | 'below'; threshold: number } | null;
    /** Projected win rate if this filter were applied */
    winRateIfFiltered: number;
    /** Projected expectancy ($/trade) if this filter were applied */
    expectancyIfFiltered: number;
    /** % of total trades that would be removed */
    tradesRemovedPercent: number;
}

export interface FilterSimulationResult {
    feature: keyof TradeSnapshot;
    direction: 'above' | 'below';
    threshold: number;
    originalTrades: number;
    remainingTrades: number;
    removedTrades: number;
    removedPercent: number;
    originalWinRate: number;
    filteredWinRate: number;
    winRateImprovement: number;
    /** PnL of remaining trades */
    filteredNetPnl: number;
    /** Expectancy (avg PnL per trade) of original trades */
    originalExpectancy: number;
    /** Expectancy (avg PnL per trade) of remaining trades */
    filteredExpectancy: number;
    /** Expectancy improvement (filtered - original) */
    expectancyImprovement: number;
    /** Profit factor of remaining trades */
    filteredProfitFactor: number;
}

/** Minimum remaining trades to accept a filter — prevents overfitting on tiny samples */
const MIN_TRADES_FOR_FILTER = 8;
/** Maximum trade removal for single-feature filters */
const MAX_SINGLE_REMOVAL = 35;
/** Maximum trade removal for combo filters */
const MAX_COMBO_REMOVAL = 40;

// ============================================================================
// Feature Metadata
// ============================================================================

const FEATURE_LABELS: Record<keyof TradeSnapshot, string> = {
    rsi: 'RSI (14)',
    adx: 'ADX',
    atrPercent: 'ATR %',
    emaDistance: 'EMA Distance %',
    volumeRatio: 'Volume Ratio',
    priceRangePos: 'Price Range Pos',
    barsFromHigh: 'Bars from High',
    barsFromLow: 'Bars from Low'
};

// ============================================================================
// Core Analysis
// ============================================================================

/**
 * Analyze trade patterns by comparing indicator snapshots of winning vs losing trades.
 * Returns features sorted by how well they discriminate wins from losses.
 */
export function analyzeTradePatterns(trades: Trade[]): FeatureAnalysis[] {
    const tradesWithSnapshots = trades.filter(t => t.entrySnapshot);
    if (tradesWithSnapshots.length < 4) return []; // Need minimum sample

    const wins = tradesWithSnapshots.filter(t => t.pnl > 0);
    const losses = tradesWithSnapshots.filter(t => t.pnl <= 0);

    if (wins.length < 2 || losses.length < 2) return []; // Need both sides

    const features = Object.keys(FEATURE_LABELS) as (keyof TradeSnapshot)[];
    const results: FeatureAnalysis[] = [];

    for (const feature of features) {
        const winValues = extractFeatureValues(wins, feature);
        const lossValues = extractFeatureValues(losses, feature);

        // Skip if not enough valid data
        if (winValues.length < 2 || lossValues.length < 2) continue;

        const winStats = computeStats(winValues);
        const lossStats = computeStats(lossValues);

        // Compute separation score using Cohen's d effect size
        const pooledStd = Math.sqrt(
            ((winStats.stddev ** 2) * (winStats.count - 1) +
                (lossStats.stddev ** 2) * (lossStats.count - 1)) /
            (winStats.count + lossStats.count - 2)
        );
        const separationScore = pooledStd > 0
            ? Math.min(1, Math.abs(winStats.mean - lossStats.mean) / pooledStd / 3)
            : 0;

        // Determine suggested filter (now optimized for expectancy)
        const suggestedFilter = findBestThreshold(tradesWithSnapshots, feature, winStats, lossStats);

        // Simulate the filter to get projected metrics
        let winRateIfFiltered = 0;
        let expectancyIfFiltered = 0;
        let tradesRemovedPercent = 0;

        if (suggestedFilter) {
            const sim = simulateFilter(tradesWithSnapshots, feature, suggestedFilter.direction, suggestedFilter.threshold);
            winRateIfFiltered = sim.filteredWinRate;
            expectancyIfFiltered = sim.filteredExpectancy;
            tradesRemovedPercent = sim.removedPercent;
        }

        results.push({
            feature,
            label: FEATURE_LABELS[feature],
            winStats,
            lossStats,
            separationScore,
            suggestedFilter,
            winRateIfFiltered,
            expectancyIfFiltered,
            tradesRemovedPercent
        });
    }

    // Sort by separation score (most discriminating first)
    results.sort((a, b) => b.separationScore - a.separationScore);

    return results;
}

/**
 * Simulate applying a filter to trades and return projected metrics.
 * Now includes expectancy and profit factor alongside win rate.
 */
export function simulateFilter(
    trades: Trade[],
    feature: keyof TradeSnapshot,
    direction: 'above' | 'below',
    threshold: number
): FilterSimulationResult {
    const tradesWithSnapshots = trades.filter(t => t.entrySnapshot);
    const originalWins = tradesWithSnapshots.filter(t => t.pnl > 0).length;
    const originalWinRate = tradesWithSnapshots.length > 0
        ? (originalWins / tradesWithSnapshots.length) * 100
        : 0;
    const originalNetPnl = tradesWithSnapshots.reduce((sum, t) => sum + t.pnl, 0);
    const originalExpectancy = tradesWithSnapshots.length > 0
        ? originalNetPnl / tradesWithSnapshots.length
        : 0;

    const remaining = tradesWithSnapshots.filter(t => {
        const val = t.entrySnapshot![feature] as number | null;
        if (val === null || val === undefined) return true; // Keep trades without data
        return direction === 'above' ? val >= threshold : val <= threshold;
    });

    const filteredWins = remaining.filter(t => t.pnl > 0).length;
    const filteredWinRate = remaining.length > 0
        ? (filteredWins / remaining.length) * 100
        : 0;

    const filteredNetPnl = remaining.reduce((sum, t) => sum + t.pnl, 0);
    const filteredExpectancy = remaining.length > 0
        ? filteredNetPnl / remaining.length
        : 0;

    // Profit factor
    const filteredGrossProfit = remaining.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const filteredGrossLoss = Math.abs(remaining.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const filteredProfitFactor = filteredGrossLoss > 0
        ? filteredGrossProfit / filteredGrossLoss
        : filteredGrossProfit > 0 ? Infinity : 0;

    const removedCount = tradesWithSnapshots.length - remaining.length;

    return {
        feature,
        direction,
        threshold,
        originalTrades: tradesWithSnapshots.length,
        remainingTrades: remaining.length,
        removedTrades: removedCount,
        removedPercent: tradesWithSnapshots.length > 0
            ? (removedCount / tradesWithSnapshots.length) * 100
            : 0,
        originalWinRate,
        filteredWinRate,
        winRateImprovement: filteredWinRate - originalWinRate,
        filteredNetPnl,
        originalExpectancy,
        filteredExpectancy,
        expectancyImprovement: filteredExpectancy - originalExpectancy,
        filteredProfitFactor
    };
}

// ============================================================================
// Helpers
// ============================================================================

function extractFeatureValues(trades: Trade[], feature: keyof TradeSnapshot): number[] {
    const values: number[] = [];
    for (const t of trades) {
        const val = t.entrySnapshot?.[feature];
        if (val !== null && val !== undefined && Number.isFinite(val as number)) {
            values.push(val as number);
        }
    }
    return values;
}

function computeStats(values: number[]): FeatureStats {
    if (values.length === 0) return { mean: 0, median: 0, stddev: 0, count: 0 };

    const count = values.length;
    const mean = values.reduce((s, v) => s + v, 0) / count;

    const sorted = [...values].sort((a, b) => a - b);
    const median = count % 2 === 1
        ? sorted[Math.floor(count / 2)]
        : (sorted[count / 2 - 1] + sorted[count / 2]) / 2;

    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (count - 1);
    const stddev = Math.sqrt(variance);

    return { mean, median, stddev, count };
}

/**
 * Find the best threshold for a feature that maximizes EXPECTANCY improvement
 * while preserving as many trades as possible.
 *
 * Approach:
 * 1. Extract all feature values from trades and build percentile candidates
 *    (5th through 95th) — this searches the ACTUAL data distribution, not
 *    just between win/loss means, so it naturally finds gentle thresholds.
 * 2. Try BOTH directions (above & below) for each candidate.
 * 3. Score with a quadratic trade-preservation penalty:
 *    score = expectancyImprovement × (keepRatio)²
 *    This makes it very hard for aggressive filters (>30% removal) to win.
 */
function findBestThreshold(
    trades: Trade[],
    feature: keyof TradeSnapshot,
    _winStats: FeatureStats,
    _lossStats: FeatureStats
): { direction: 'above' | 'below'; threshold: number } | null {
    // Collect all feature values to build percentile-based candidates
    const allValues = extractFeatureValues(trades, feature);
    if (allValues.length < 6) return null;

    const sorted = [...allValues].sort((a, b) => a - b);

    // Generate candidate thresholds at 5th, 10th, 15th, ..., 95th percentiles
    const candidates: number[] = [];
    for (let p = 5; p <= 95; p += 5) {
        const idx = Math.min(Math.floor((p / 100) * sorted.length), sorted.length - 1);
        candidates.push(sorted[idx]);
    }
    // Deduplicate (common in discrete features like barsFromHigh)
    const uniqueCandidates = [...new Set(candidates)];

    let bestDirection: 'above' | 'below' = 'above';
    let bestThreshold = 0;
    let bestScore = -Infinity;

    const directions: ('above' | 'below')[] = ['above', 'below'];

    for (const dir of directions) {
        for (const candidate of uniqueCandidates) {
            const sim = simulateFilter(trades, feature, dir, candidate);

            // Hard constraints
            if (sim.remainingTrades < MIN_TRADES_FOR_FILTER) continue;
            if (sim.removedPercent > MAX_SINGLE_REMOVAL) continue;
            if (sim.expectancyImprovement <= 0) continue;

            // Score: expectancy improvement × (keep ratio)²
            // Quadratic penalty: removing 20% → (0.8)² = 0.64, removing 30% → (0.7)² = 0.49
            // This strongly prefers filters that remove fewer trades
            const keepRatio = 1 - sim.removedPercent / 100;
            const score = sim.expectancyImprovement * (keepRatio * keepRatio);

            if (score > bestScore) {
                bestScore = score;
                bestThreshold = candidate;
                bestDirection = dir;
            }
        }
    }

    if (bestScore <= 0) return null;

    // Final validation
    const finalSim = simulateFilter(trades, feature, bestDirection, bestThreshold);
    if (finalSim.expectancyImprovement <= 0) return null;
    if (finalSim.remainingTrades < MIN_TRADES_FOR_FILTER) return null;

    return { direction: bestDirection, threshold: Math.round(bestThreshold * 100) / 100 };
}

// ============================================================================
// Combo (Multi-Feature) Filters
// ============================================================================

export interface ComboFilterEntry {
    feature: keyof TradeSnapshot;
    label: string;
    direction: 'above' | 'below';
    threshold: number;
}

export interface ComboFilterResult {
    filters: ComboFilterEntry[];
    originalTrades: number;
    remainingTrades: number;
    removedTrades: number;
    removedPercent: number;
    originalWinRate: number;
    filteredWinRate: number;
    winRateImprovement: number;
    filteredNetPnl: number;
    /** Original expectancy ($/trade) */
    originalExpectancy: number;
    /** Filtered expectancy ($/trade) */
    filteredExpectancy: number;
    /** Expectancy improvement (filtered - original) */
    expectancyImprovement: number;
    /** Profit factor of remaining trades */
    filteredProfitFactor: number;
}

/**
 * Simulate applying multiple filters simultaneously (AND logic).
 * A trade is kept only if it passes ALL filter conditions.
 */
export function simulateComboFilter(
    trades: Trade[],
    filters: ComboFilterEntry[]
): ComboFilterResult {
    const tradesWithSnapshots = trades.filter(t => t.entrySnapshot);
    const originalWins = tradesWithSnapshots.filter(t => t.pnl > 0).length;
    const originalWinRate = tradesWithSnapshots.length > 0
        ? (originalWins / tradesWithSnapshots.length) * 100
        : 0;
    const originalNetPnl = tradesWithSnapshots.reduce((sum, t) => sum + t.pnl, 0);
    const originalExpectancy = tradesWithSnapshots.length > 0
        ? originalNetPnl / tradesWithSnapshots.length
        : 0;

    const remaining = tradesWithSnapshots.filter(t => {
        for (const f of filters) {
            const val = t.entrySnapshot![f.feature] as number | null;
            if (val === null || val === undefined) continue; // Skip null values
            if (f.direction === 'above' && val < f.threshold) return false;
            if (f.direction === 'below' && val > f.threshold) return false;
        }
        return true;
    });

    const filteredWins = remaining.filter(t => t.pnl > 0).length;
    const filteredWinRate = remaining.length > 0
        ? (filteredWins / remaining.length) * 100
        : 0;
    const removedCount = tradesWithSnapshots.length - remaining.length;
    const filteredNetPnl = remaining.reduce((sum, t) => sum + t.pnl, 0);
    const filteredExpectancy = remaining.length > 0
        ? filteredNetPnl / remaining.length
        : 0;

    // Profit factor
    const filteredGrossProfit = remaining.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const filteredGrossLoss = Math.abs(remaining.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const filteredProfitFactor = filteredGrossLoss > 0
        ? filteredGrossProfit / filteredGrossLoss
        : filteredGrossProfit > 0 ? Infinity : 0;

    return {
        filters,
        originalTrades: tradesWithSnapshots.length,
        remainingTrades: remaining.length,
        removedTrades: removedCount,
        removedPercent: tradesWithSnapshots.length > 0
            ? (removedCount / tradesWithSnapshots.length) * 100
            : 0,
        originalWinRate,
        filteredWinRate,
        winRateImprovement: filteredWinRate - originalWinRate,
        filteredNetPnl,
        originalExpectancy,
        filteredExpectancy,
        expectancyImprovement: filteredExpectancy - originalExpectancy,
        filteredProfitFactor
    };
}

/**
 * Build the best combo filter from the top N features that have suggested filters.
 * Tries pairs and triples, returns the best combo that improves EXPECTANCY
 * while keeping enough trades to be statistically meaningful.
 *
 * Uses quadratic trade-preservation penalty to strongly prefer combos
 * that don't remove too many trades.
 */
export function findBestComboFilter(
    trades: Trade[],
    analyses: FeatureAnalysis[],
    maxRemovalPercent: number = MAX_COMBO_REMOVAL
): ComboFilterResult | null {
    const withFilters = analyses.filter(a => a.suggestedFilter !== null);
    if (withFilters.length < 2) return null;

    const candidates: ComboFilterResult[] = [];

    // Try all pairs
    for (let i = 0; i < withFilters.length; i++) {
        for (let j = i + 1; j < withFilters.length; j++) {
            const filters: ComboFilterEntry[] = [
                { feature: withFilters[i].feature, label: withFilters[i].label, ...withFilters[i].suggestedFilter! },
                { feature: withFilters[j].feature, label: withFilters[j].label, ...withFilters[j].suggestedFilter! }
            ];
            const result = simulateComboFilter(trades, filters);
            if (result.removedPercent <= maxRemovalPercent
                && result.remainingTrades >= MIN_TRADES_FOR_FILTER
                && result.expectancyImprovement > 0) {
                candidates.push(result);
            }
        }
    }

    // Try triples (if enough features)
    if (withFilters.length >= 3) {
        for (let i = 0; i < withFilters.length; i++) {
            for (let j = i + 1; j < withFilters.length; j++) {
                for (let k = j + 1; k < withFilters.length; k++) {
                    const filters: ComboFilterEntry[] = [
                        { feature: withFilters[i].feature, label: withFilters[i].label, ...withFilters[i].suggestedFilter! },
                        { feature: withFilters[j].feature, label: withFilters[j].label, ...withFilters[j].suggestedFilter! },
                        { feature: withFilters[k].feature, label: withFilters[k].label, ...withFilters[k].suggestedFilter! }
                    ];
                    const result = simulateComboFilter(trades, filters);
                    if (result.removedPercent <= maxRemovalPercent
                        && result.remainingTrades >= MIN_TRADES_FOR_FILTER
                        && result.expectancyImprovement > 0) {
                        candidates.push(result);
                    }
                }
            }
        }
    }

    if (candidates.length === 0) return null;

    // Rank with quadratic trade preservation: score = expectancyImprovement × (keepRatio)²
    candidates.sort((a, b) => {
        const keepA = 1 - a.removedPercent / 100;
        const keepB = 1 - b.removedPercent / 100;
        const scoreA = a.expectancyImprovement * (keepA * keepA);
        const scoreB = b.expectancyImprovement * (keepB * keepB);
        return scoreB - scoreA;
    });

    return candidates[0];
}
