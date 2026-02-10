
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
}

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

        // Determine suggested filter
        const suggestedFilter = findBestThreshold(tradesWithSnapshots, feature, winStats, lossStats);

        // Simulate the filter to get projected metrics
        let winRateIfFiltered = 0;
        let tradesRemovedPercent = 0;

        if (suggestedFilter) {
            const sim = simulateFilter(tradesWithSnapshots, feature, suggestedFilter.direction, suggestedFilter.threshold);
            winRateIfFiltered = sim.filteredWinRate;
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
            tradesRemovedPercent
        });
    }

    // Sort by separation score (most discriminating first)
    results.sort((a, b) => b.separationScore - a.separationScore);

    return results;
}

/**
 * Simulate applying a filter to trades and return projected metrics.
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

    const remaining = tradesWithSnapshots.filter(t => {
        const val = t.entrySnapshot![feature] as number | null;
        if (val === null || val === undefined) return true; // Keep trades without data
        return direction === 'above' ? val >= threshold : val <= threshold;
    });

    const filteredWins = remaining.filter(t => t.pnl > 0).length;
    const filteredWinRate = remaining.length > 0
        ? (filteredWins / remaining.length) * 100
        : 0;

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
        filteredNetPnl: remaining.reduce((sum, t) => sum + t.pnl, 0)
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
 * Find the best threshold for a feature that maximizes win rate improvement
 * while not removing too many trades (max 40% removal).
 */
function findBestThreshold(
    trades: Trade[],
    feature: keyof TradeSnapshot,
    winStats: FeatureStats,
    lossStats: FeatureStats
): { direction: 'above' | 'below'; threshold: number } | null {
    // Determine direction: if losses have higher mean, filter below (keep above)
    // If losses have lower mean, filter above (keep below)
    const direction: 'above' | 'below' = lossStats.mean > winStats.mean ? 'below' : 'above';

    // Try thresholds between the two means
    const lo = Math.min(winStats.mean, lossStats.mean);
    const hi = Math.max(winStats.mean, lossStats.mean);
    const steps = 10;

    let bestThreshold = direction === 'above' ? lo : hi;
    let bestScore = -Infinity;

    for (let i = 0; i <= steps; i++) {
        const candidate = lo + (hi - lo) * (i / steps);
        const sim = simulateFilter(trades, feature, direction, candidate);

        // Score: win rate improvement with penalty for removing too many trades
        if (sim.removedPercent > 40) continue;
        const score = sim.winRateImprovement - sim.removedPercent * 0.1;
        if (score > bestScore) {
            bestScore = score;
            bestThreshold = candidate;
        }
    }

    // Only suggest if there's meaningful improvement
    const finalSim = simulateFilter(trades, feature, direction, bestThreshold);
    if (finalSim.winRateImprovement < 1) return null;

    return { direction, threshold: Math.round(bestThreshold * 100) / 100 };
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
        filteredNetPnl: remaining.reduce((sum, t) => sum + t.pnl, 0)
    };
}

/**
 * Build the best combo filter from the top N features that have suggested filters.
 * Tries pairs and triples, returns the best combo that improves win rate
 * while keeping trade removal under maxRemovalPercent.
 */
export function findBestComboFilter(
    trades: Trade[],
    analyses: FeatureAnalysis[],
    maxRemovalPercent: number = 60
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
            if (result.removedPercent <= maxRemovalPercent && result.winRateImprovement > 0) {
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
                    if (result.removedPercent <= maxRemovalPercent && result.winRateImprovement > 0) {
                        candidates.push(result);
                    }
                }
            }
        }
    }

    if (candidates.length === 0) return null;

    // Rank: maximize (winRateImprovement) with penalty for excessive removal
    candidates.sort((a, b) => {
        const scoreA = a.winRateImprovement - a.removedPercent * 0.05;
        const scoreB = b.winRateImprovement - b.removedPercent * 0.05;
        return scoreB - scoreA;
    });

    return candidates[0];
}
