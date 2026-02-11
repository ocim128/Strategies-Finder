
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

export interface AnalysisOptions {
    mode?: 'quality' | 'relax_aware';
    maxSingleRemoval?: number;
    relaxExpectancyTolerancePct?: number;
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
    /** Original max drawdown over cumulative trade PnL sequence */
    originalMaxDrawdown: number;
    /** Filtered max drawdown over cumulative trade PnL sequence */
    filteredMaxDrawdown: number;
    /** Drawdown improvement in $ (original - filtered, higher is better) */
    drawdownImprovement: number;
}

export interface AnalysisFinderOptions {
    minFeatureScorePct?: number;
    randomTrials?: number;
    refineTrials?: number;
    /** Percentage of the 0..suggested-threshold interval to scan (1-100). */
    rangePercent?: number;
    /** Maximum number of filters combined per candidate. */
    maxFeaturesPerCandidate?: number;
    minBadRemovedPct?: number;
    maxGoodRemovedPct?: number;
    maxTotalRemovedPct?: number;
}

export interface FinderFeatureRange {
    feature: keyof TradeSnapshot;
    label: string;
    direction: 'above' | 'below';
    suggestedThreshold: number;
    minThreshold: number;
    maxThreshold: number;
}

export interface AnalysisFinderCandidate {
    filters: ComboFilterEntry[];
    simulation: ComboFilterResult;
    objectiveScore: number;
    badTradesRemoved: number;
    goodTradesRemoved: number;
    badTradesRemovedPct: number;
    goodTradesRemovedPct: number;
}

export interface AnalysisFilterFinderResult {
    featureRanges: FinderFeatureRange[];
    attemptedCount: number;
    feasibleCount: number;
    rejectedByConstraints: number;
    bestCandidate: AnalysisFinderCandidate | null;
    topCandidates: AnalysisFinderCandidate[];
}

/** Minimum remaining trades to accept a filter — prevents overfitting on tiny samples */
const MIN_TRADES_FOR_FILTER = 8;
/** Maximum trade removal for single-feature filters */
const MAX_SINGLE_REMOVAL = 35;
/** Maximum trade removal for combo filters */
const MAX_COMBO_REMOVAL = 40;
const DEFAULT_FINDER_MIN_SCORE_PCT = 10;
const DEFAULT_FINDER_RANDOM_TRIALS = 300;
const DEFAULT_FINDER_REFINE_TRIALS = 120;
const DEFAULT_FINDER_RANGE_PCT = 100;
const DEFAULT_FINDER_MAX_FEATURES = 3;
const DEFAULT_FINDER_MIN_BAD_REMOVED_PCT = 20;
const DEFAULT_FINDER_MAX_GOOD_REMOVED_PCT = 8;
const DEFAULT_FINDER_MAX_TOTAL_REMOVED_PCT = 25;
const FINDER_TOP_RESULTS = 5;
const FINDER_SEED_POOL_SIZE = 8;

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
    barsFromLow: 'Bars from Low',
    trendEfficiency: 'Trend Efficiency',
    atrRegimeRatio: 'ATR Regime Ratio',
    bodyPercent: 'Body Strength %',
    wickSkew: 'Wick Skew %',
    closeLocation: 'Close Location %',
    oppositeWickPercent: 'Opposite Wick %',
    rangeAtrMultiple: 'Range / ATR',
    momentumConsistency: 'Momentum Consistency %',
    breakQuality: 'Break Quality',
    tf60Perf: 'TF 60m Perf %',
    tf90Perf: 'TF 90m Perf %',
    tf120Perf: 'TF 120m Perf %',
    tf480Perf: 'TF 480m Perf %',
    entryQualityScore: 'Entry Quality Score',
    volumeTrend: 'Volume Trend',
    volumeBurst: 'Volume Burst',
    volumePriceDivergence: 'Vol-Price Agreement',
    volumeConsistency: 'Volume Consistency'
};

const EXCLUDED_ENTRY_QUALITY_FEATURES = new Set<keyof TradeSnapshot>([
    'barsFromHigh',
    'barsFromLow',
    'volumeConsistency',
    'momentumConsistency',
    'wickSkew',
    'volumePriceDivergence',
    'entryQualityScore',
    'closeLocation',
    'oppositeWickPercent',
    'emaDistance',
    'breakQuality',
    'rsi',
    'priceRangePos',
]);

/**
 * Some settings only support a single filter direction in the UI/runtime.
 * barsFromHigh/barsFromLow are max-only (<= threshold), so only "below" is valid.
 */
const FEATURE_DIRECTIONS: Record<keyof TradeSnapshot, ('above' | 'below')[]> = {
    rsi: ['above', 'below'],
    adx: ['above', 'below'],
    atrPercent: ['above', 'below'],
    emaDistance: ['above', 'below'],
    volumeRatio: ['above', 'below'],
    priceRangePos: ['above', 'below'],
    barsFromHigh: ['below'],
    barsFromLow: ['below'],
    trendEfficiency: ['above', 'below'],
    atrRegimeRatio: ['above', 'below'],
    bodyPercent: ['above', 'below'],
    wickSkew: ['above', 'below'],
    closeLocation: ['above'],
    oppositeWickPercent: ['below'],
    rangeAtrMultiple: ['above', 'below'],
    momentumConsistency: ['above'],
    breakQuality: ['above'],
    tf60Perf: ['above', 'below'],
    tf90Perf: ['above', 'below'],
    tf120Perf: ['above', 'below'],
    tf480Perf: ['above', 'below'],
    entryQualityScore: ['above'],
    volumeTrend: ['above', 'below'],
    volumeBurst: ['above', 'below'],
    volumePriceDivergence: ['above', 'below'],
    volumeConsistency: ['above', 'below']
};

// ============================================================================
// Core Analysis
// ============================================================================

/**
 * Analyze trade patterns by comparing indicator snapshots of winning vs losing trades.
 * Returns features sorted by how well they discriminate wins from losses.
 */
export function analyzeTradePatterns(trades: Trade[], options: AnalysisOptions = {}): FeatureAnalysis[] {
    const tradesWithSnapshots = trades.filter(t => t.entrySnapshot);
    if (tradesWithSnapshots.length < 4) return []; // Need minimum sample

    const wins = tradesWithSnapshots.filter(t => t.pnl > 0);
    const losses = tradesWithSnapshots.filter(t => t.pnl <= 0);

    if (wins.length < 2 || losses.length < 2) return []; // Need both sides

    const features = (Object.keys(FEATURE_LABELS) as (keyof TradeSnapshot)[])
        .filter(feature => !EXCLUDED_ENTRY_QUALITY_FEATURES.has(feature));
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
        const suggestedFilter = findBestThreshold(tradesWithSnapshots, feature, winStats, lossStats, options);

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
    const originalMaxDrawdown = computeMaxDrawdownFromTradeSequence(tradesWithSnapshots);

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
    const filteredMaxDrawdown = computeMaxDrawdownFromTradeSequence(remaining);

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
        filteredProfitFactor,
        originalMaxDrawdown,
        filteredMaxDrawdown,
        drawdownImprovement: originalMaxDrawdown - filteredMaxDrawdown
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

function computeMaxDrawdownFromTradeSequence(trades: Trade[]): number {
    let equity = 0;
    let peak = 0;
    let maxDrawdown = 0;

    for (const trade of trades) {
        equity += trade.pnl;
        if (equity > peak) peak = equity;
        const drawdown = peak - equity;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    return maxDrawdown;
}

/**
 * Find the best threshold for a feature that maximizes EXPECTANCY improvement
 * while preserving as many trades as possible.
 *
 * Approach:
 * 1. Extract all feature values from trades and build percentile candidates
 *    (5th through 95th) — this searches the ACTUAL data distribution, not
 *    just between win/loss means, so it naturally finds gentle thresholds.
 * 2. Try supported directions for each candidate.
 * 3. Score with a quadratic trade-preservation penalty:
 *    score = expectancyImprovement × (keepRatio)²
 *    This makes it very hard for aggressive filters (>30% removal) to win.
 */
function findBestThreshold(
    trades: Trade[],
    feature: keyof TradeSnapshot,
    _winStats: FeatureStats,
    _lossStats: FeatureStats,
    options: AnalysisOptions
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
    const uniqueCandidates = [...new Set(candidates)];

    let bestDirection: 'above' | 'below' = 'above';
    let bestThreshold = 0;
    let bestScore = -Infinity;

    const mode = options.mode ?? 'quality';
    const maxRemoval = clamp(options.maxSingleRemoval ?? (mode === 'relax_aware' ? 20 : MAX_SINGLE_REMOVAL), 5, 90);
    const relaxTolerance = clamp(options.relaxExpectancyTolerancePct ?? 0.1, 0, 0.6);
    const directions = FEATURE_DIRECTIONS[feature] ?? ['above', 'below'];

    for (const dir of directions) {
        for (const candidate of uniqueCandidates) {
            const sim = simulateFilter(trades, feature, dir, candidate);

            if (sim.remainingTrades < MIN_TRADES_FOR_FILTER) continue;
            if (sim.removedPercent > maxRemoval) continue;

            const keepRatio = 1 - sim.removedPercent / 100;
            let score = -Infinity;

            if (mode === 'quality') {
                if (sim.expectancyImprovement <= 0) continue;
                score = sim.expectancyImprovement * (keepRatio * keepRatio);
            } else {
                const baselineExp = sim.originalExpectancy;
                const minAllowedExpectancy = baselineExp - Math.max(0.05, Math.abs(baselineExp) * relaxTolerance);
                if (sim.filteredExpectancy < minAllowedExpectancy) continue;

                const expectancyRetention = baselineExp === 0
                    ? (sim.filteredExpectancy >= 0 ? 1 : 0)
                    : sim.filteredExpectancy / baselineExp;
                const baselineNetPnl = baselineExp * sim.originalTrades;
                const netPnlRetention = baselineNetPnl <= 0
                    ? 0
                    : sim.filteredNetPnl / baselineNetPnl;

                const expTerm = clamp(expectancyRetention, 0, 1.5);
                const pnlTerm = clamp(netPnlRetention, 0, 1.5);

                // Relax-aware score: strongly reward retention while maintaining expectancy.
                score = (keepRatio ** 4) * ((0.7 * expTerm) + (0.3 * pnlTerm)) + Math.max(0, sim.expectancyImprovement) * 0.05;
            }

            if (score > bestScore) {
                bestScore = score;
                bestThreshold = candidate;
                bestDirection = dir;
            }
        }
    }

    if (bestScore <= 0) return null;

    const finalSim = simulateFilter(trades, feature, bestDirection, bestThreshold);
    if (mode === 'quality' && finalSim.expectancyImprovement <= 0) return null;
    if (finalSim.remainingTrades < MIN_TRADES_FOR_FILTER) return null;
    if (finalSim.removedPercent > maxRemoval) return null;

    return {
        direction: bestDirection,
        threshold: normalizeSuggestedThreshold(bestThreshold)
    };
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function normalizeSuggestedThreshold(value: number): number {
    if (!Number.isFinite(value)) return 0;
    if (value === 0) return 0;

    const abs = Math.abs(value);
    const decimals = abs >= 100 ? 2
        : abs >= 1 ? 3
            : abs >= 0.1 ? 4
                : abs >= 0.01 ? 5
                    : 6;

    let normalized = Number(value.toFixed(decimals));

    // Keep tiny but non-zero thresholds non-zero because zero is "disabled" for many filters.
    if (normalized === 0) {
        const epsilon = 10 ** -decimals;
        normalized = value > 0 ? epsilon : -epsilon;
    }

    return normalized;
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
    originalWinningTrades: number;
    originalLosingTrades: number;
    remainingTrades: number;
    remainingWinningTrades: number;
    remainingLosingTrades: number;
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
    /** Original max drawdown over cumulative trade PnL sequence */
    originalMaxDrawdown: number;
    /** Filtered max drawdown over cumulative trade PnL sequence */
    filteredMaxDrawdown: number;
    /** Drawdown improvement in $ (original - filtered, higher is better) */
    drawdownImprovement: number;
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
    const originalLosses = tradesWithSnapshots.length - originalWins;
    const originalWinRate = tradesWithSnapshots.length > 0
        ? (originalWins / tradesWithSnapshots.length) * 100
        : 0;
    const originalNetPnl = tradesWithSnapshots.reduce((sum, t) => sum + t.pnl, 0);
    const originalExpectancy = tradesWithSnapshots.length > 0
        ? originalNetPnl / tradesWithSnapshots.length
        : 0;
    const originalMaxDrawdown = computeMaxDrawdownFromTradeSequence(tradesWithSnapshots);

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
    const filteredLosses = remaining.length - filteredWins;
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
    const filteredMaxDrawdown = computeMaxDrawdownFromTradeSequence(remaining);

    return {
        filters,
        originalTrades: tradesWithSnapshots.length,
        originalWinningTrades: originalWins,
        originalLosingTrades: originalLosses,
        remainingTrades: remaining.length,
        remainingWinningTrades: filteredWins,
        remainingLosingTrades: filteredLosses,
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
        filteredProfitFactor,
        originalMaxDrawdown,
        filteredMaxDrawdown,
        drawdownImprovement: originalMaxDrawdown - filteredMaxDrawdown
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

interface NormalizedFinderOptions {
    minFeatureScorePct: number;
    randomTrials: number;
    refineTrials: number;
    rangePercent: number;
    maxFeaturesPerCandidate: number;
    minBadRemovedPct: number;
    maxGoodRemovedPct: number;
    maxTotalRemovedPct: number;
}

export function runAnalysisFilterFinder(
    trades: Trade[],
    analyses: FeatureAnalysis[],
    options: AnalysisFinderOptions = {}
): AnalysisFilterFinderResult {
    const tradesWithSnapshots = trades.filter(t => t.entrySnapshot);
    if (tradesWithSnapshots.length < MIN_TRADES_FOR_FILTER || analyses.length === 0) {
        return {
            featureRanges: [],
            attemptedCount: 0,
            feasibleCount: 0,
            rejectedByConstraints: 0,
            bestCandidate: null,
            topCandidates: []
        };
    }

    const normalized = normalizeFinderOptions(options);
    const featureRanges = buildFinderFeatureRanges(
        tradesWithSnapshots,
        analyses,
        normalized.minFeatureScorePct,
        normalized.rangePercent
    );

    if (featureRanges.length === 0) {
        return {
            featureRanges,
            attemptedCount: 0,
            feasibleCount: 0,
            rejectedByConstraints: 0,
            bestCandidate: null,
            topCandidates: []
        };
    }

    let attemptedCount = 0;
    let rejectedByConstraints = 0;
    const acceptedCandidates: AnalysisFinderCandidate[] = [];
    const seenCandidateKeys = new Set<string>();

    for (const range of featureRanges) {
        const filter: ComboFilterEntry = {
            feature: range.feature,
            label: range.label,
            direction: range.direction,
            threshold: normalizeSuggestedThreshold(
                clamp(range.suggestedThreshold, range.minThreshold, range.maxThreshold)
            )
        };
        const key = buildFinderCandidateKey([filter]);
        if (seenCandidateKeys.has(key)) continue;
        seenCandidateKeys.add(key);
        attemptedCount++;

        const candidate = evaluateFinderCandidate(tradesWithSnapshots, [filter], normalized);
        if (!candidate) {
            rejectedByConstraints++;
            continue;
        }
        acceptedCandidates.push(candidate);
    }

    for (let i = 0; i < normalized.randomTrials; i++) {
        const filters = buildRandomCandidateFilters(featureRanges, normalized.maxFeaturesPerCandidate);
        const key = buildFinderCandidateKey(filters);
        if (seenCandidateKeys.has(key)) continue;
        seenCandidateKeys.add(key);
        attemptedCount++;

        const candidate = evaluateFinderCandidate(tradesWithSnapshots, filters, normalized);
        if (!candidate) {
            rejectedByConstraints++;
            continue;
        }
        acceptedCandidates.push(candidate);
    }

    const seedPool = [...acceptedCandidates]
        .sort(compareFinderCandidates)
        .slice(0, FINDER_SEED_POOL_SIZE);

    if (seedPool.length > 0) {
        for (let i = 0; i < normalized.refineTrials; i++) {
            const seed = seedPool[i % seedPool.length];
            const filters = buildRefinedCandidateFilters(seed.filters, featureRanges);
            const key = buildFinderCandidateKey(filters);
            if (seenCandidateKeys.has(key)) continue;
            seenCandidateKeys.add(key);
            attemptedCount++;

            const candidate = evaluateFinderCandidate(tradesWithSnapshots, filters, normalized);
            if (!candidate) {
                rejectedByConstraints++;
                continue;
            }
            acceptedCandidates.push(candidate);
        }
    }

    const sortedCandidates = acceptedCandidates
        .sort(compareFinderCandidates)
        .slice(0, FINDER_TOP_RESULTS);

    return {
        featureRanges,
        attemptedCount,
        feasibleCount: acceptedCandidates.length,
        rejectedByConstraints,
        bestCandidate: sortedCandidates[0] ?? null,
        topCandidates: sortedCandidates
    };
}

function normalizeFinderOptions(options: AnalysisFinderOptions): NormalizedFinderOptions {
    return {
        minFeatureScorePct: clamp(
            options.minFeatureScorePct ?? DEFAULT_FINDER_MIN_SCORE_PCT,
            0,
            100
        ),
        randomTrials: Math.max(
            1,
            Math.round(options.randomTrials ?? DEFAULT_FINDER_RANDOM_TRIALS)
        ),
        refineTrials: Math.max(
            0,
            Math.round(options.refineTrials ?? DEFAULT_FINDER_REFINE_TRIALS)
        ),
        rangePercent: clamp(options.rangePercent ?? DEFAULT_FINDER_RANGE_PCT, 1, 100),
        maxFeaturesPerCandidate: Math.max(
            1,
            Math.round(options.maxFeaturesPerCandidate ?? DEFAULT_FINDER_MAX_FEATURES)
        ),
        minBadRemovedPct: clamp(
            options.minBadRemovedPct ?? DEFAULT_FINDER_MIN_BAD_REMOVED_PCT,
            0,
            100
        ),
        maxGoodRemovedPct: clamp(
            options.maxGoodRemovedPct ?? DEFAULT_FINDER_MAX_GOOD_REMOVED_PCT,
            0,
            100
        ),
        maxTotalRemovedPct: clamp(
            options.maxTotalRemovedPct ?? DEFAULT_FINDER_MAX_TOTAL_REMOVED_PCT,
            0,
            100
        )
    };
}

function buildFinderFeatureRanges(
    trades: Trade[],
    analyses: FeatureAnalysis[],
    minFeatureScorePct: number,
    rangePercent: number
): FinderFeatureRange[] {
    const scoreThreshold = minFeatureScorePct / 100;
    const rangeScale = clamp(rangePercent, 1, 100) / 100;
    const ranges: FinderFeatureRange[] = [];

    for (const analysis of analyses) {
        if (!analysis.suggestedFilter) continue;
        if (analysis.separationScore < scoreThreshold) continue;

        const values = extractFeatureValues(trades, analysis.feature);
        if (values.length < 6) continue;
        const sorted = [...values].sort((a, b) => a - b);

        const p05 = percentileFromSorted(sorted, 0.05);
        const p95 = percentileFromSorted(sorted, 0.95);
        if (!Number.isFinite(p05) || !Number.isFinite(p95) || p95 < p05) continue;

        const suggestedThreshold = analysis.suggestedFilter.threshold;
        const scaledSuggestion = suggestedThreshold * rangeScale;
        const baseMin = Math.min(0, scaledSuggestion);
        const baseMax = Math.max(0, scaledSuggestion);

        let minThreshold = Math.max(baseMin, p05);
        let maxThreshold = Math.min(baseMax, p95);

        if (maxThreshold < minThreshold) {
            const safeSuggested = clamp(suggestedThreshold, p05, p95);
            const zeroClamped = clamp(0, p05, p95);
            minThreshold = Math.min(safeSuggested, zeroClamped);
            maxThreshold = Math.max(safeSuggested, zeroClamped);
        }

        if (maxThreshold - minThreshold < 1e-9) {
            const localSpan = Math.max(1e-6, (p95 - p05) * 0.1);
            minThreshold = clamp(minThreshold - localSpan / 2, p05, p95);
            maxThreshold = clamp(maxThreshold + localSpan / 2, p05, p95);
        }

        if (maxThreshold < minThreshold) continue;

        ranges.push({
            feature: analysis.feature,
            label: analysis.label,
            direction: analysis.suggestedFilter.direction,
            suggestedThreshold: normalizeSuggestedThreshold(
                clamp(suggestedThreshold, minThreshold, maxThreshold)
            ),
            minThreshold,
            maxThreshold
        });
    }

    return ranges;
}

function buildRandomCandidateFilters(
    featureRanges: FinderFeatureRange[],
    maxFeaturesPerCandidate: number
): ComboFilterEntry[] {
    const maxFeatures = Math.max(1, Math.min(featureRanges.length, maxFeaturesPerCandidate));
    const selectedCount = Math.max(1, Math.floor(Math.random() * maxFeatures) + 1);
    const shuffled = [...featureRanges];

    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    return shuffled.slice(0, selectedCount).map(range => ({
        feature: range.feature,
        label: range.label,
        direction: range.direction,
        threshold: normalizeSuggestedThreshold(randomThresholdBetween(range.minThreshold, range.maxThreshold))
    }));
}

function buildRefinedCandidateFilters(
    seedFilters: ComboFilterEntry[],
    featureRanges: FinderFeatureRange[]
): ComboFilterEntry[] {
    const rangesByFeature = new Map<keyof TradeSnapshot, FinderFeatureRange>(
        featureRanges.map(range => [range.feature, range])
    );

    return seedFilters.map(filter => {
        const range = rangesByFeature.get(filter.feature);
        if (!range) return filter;

        const fullSpan = Math.max(1e-6, range.maxThreshold - range.minThreshold);
        const localHalfSpan = fullSpan * 0.15;
        const localMin = clamp(filter.threshold - localHalfSpan, range.minThreshold, range.maxThreshold);
        const localMax = clamp(filter.threshold + localHalfSpan, range.minThreshold, range.maxThreshold);
        const sampledThreshold = normalizeSuggestedThreshold(randomThresholdBetween(localMin, localMax));

        return {
            feature: filter.feature,
            label: filter.label,
            direction: filter.direction,
            threshold: sampledThreshold
        };
    });
}

function randomThresholdBetween(min: number, max: number): number {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
    if (max <= min) return min;
    return min + (max - min) * Math.random();
}

function evaluateFinderCandidate(
    trades: Trade[],
    filters: ComboFilterEntry[],
    options: NormalizedFinderOptions
): AnalysisFinderCandidate | null {
    const simulation = simulateComboFilter(trades, filters);
    if (simulation.remainingTrades < MIN_TRADES_FOR_FILTER) return null;
    if (simulation.expectancyImprovement <= 0) return null;
    if (simulation.removedPercent > options.maxTotalRemovedPct) return null;

    const badTradesRemoved = simulation.originalLosingTrades - simulation.remainingLosingTrades;
    const goodTradesRemoved = simulation.originalWinningTrades - simulation.remainingWinningTrades;
    const badTradesRemovedPct = simulation.originalLosingTrades > 0
        ? (badTradesRemoved / simulation.originalLosingTrades) * 100
        : 0;
    const goodTradesRemovedPct = simulation.originalWinningTrades > 0
        ? (goodTradesRemoved / simulation.originalWinningTrades) * 100
        : 0;

    if (badTradesRemovedPct < options.minBadRemovedPct) return null;
    if (goodTradesRemovedPct > options.maxGoodRemovedPct) return null;

    const objectiveScore = computeFinderObjective(simulation, goodTradesRemovedPct);

    return {
        filters,
        simulation,
        objectiveScore,
        badTradesRemoved,
        goodTradesRemoved,
        badTradesRemovedPct,
        goodTradesRemovedPct
    };
}

function computeFinderObjective(
    simulation: ComboFilterResult,
    goodTradesRemovedPct: number
): number {
    return simulation.expectancyImprovement
        + (0.04 * simulation.winRateImprovement)
        - (0.08 * goodTradesRemovedPct)
        - (0.03 * simulation.removedPercent);
}

function compareFinderCandidates(a: AnalysisFinderCandidate, b: AnalysisFinderCandidate): number {
    if (b.objectiveScore !== a.objectiveScore) {
        return b.objectiveScore - a.objectiveScore;
    }
    if (b.simulation.expectancyImprovement !== a.simulation.expectancyImprovement) {
        return b.simulation.expectancyImprovement - a.simulation.expectancyImprovement;
    }
    return a.simulation.removedPercent - b.simulation.removedPercent;
}

function buildFinderCandidateKey(filters: ComboFilterEntry[]): string {
    const normalized = [...filters]
        .sort((a, b) => String(a.feature).localeCompare(String(b.feature)))
        .map(filter => `${String(filter.feature)}:${filter.direction}:${filter.threshold.toFixed(6)}`);
    return normalized.join('|');
}

function percentileFromSorted(sortedValues: number[], percentile: number): number {
    if (sortedValues.length === 0) return 0;
    if (sortedValues.length === 1) return sortedValues[0];

    const clamped = clamp(percentile, 0, 1);
    const scaledIndex = clamped * (sortedValues.length - 1);
    const lower = Math.floor(scaledIndex);
    const upper = Math.ceil(scaledIndex);
    if (lower === upper) return sortedValues[lower];
    const weight = scaledIndex - lower;
    return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * weight;
}

