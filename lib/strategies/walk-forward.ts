import { OHLCVData, BacktestResult, StrategyParams, BacktestSettings, Strategy, Time } from '../types/strategies';
import { runBacktest, runBacktestCompact, calculateBacktestStats, calculateMaxDrawdown, compareTime } from './backtest';
import { ensureCleanData } from './strategy-helpers';
import { sanitizeSharpeRatio } from './performance-metrics';

// ============================================================================
// Walk-Forward Analysis (WFA) Module
// ============================================================================
//
// Theory of Operation:
// WFA is a method to robustness-test a strategy by checking if its params likely to work in future.
// It avoids "overfitting" (finding params that just memorized the past) by:
// 1. Sliding Window: Moving a conceptual window (Optimization + Test) across history.
// 2. Optimization (In-Sample): Finding best params in the first part of the window.
// 3. Testing (Out-Of-Sample): Running those params on the UNSEEN second part.
//
// This file implements:
// - Grid Search generator (create parameter combinations).
// - Window Optimization loop (find best params for each In-Sample period).
// - Forward testing (validate on OOS period).
// - Aggregation (combine all OOS pieces to see how the strategy would have performed "live").
//
// ============================================================================
// Walk-Forward Analysis Types
// ============================================================================

export interface WalkForwardConfig {
    /** Number of bars in optimization (in-sample) window */
    optimizationWindow: number;
    /** Number of bars in test (out-of-sample) window */
    testWindow: number;
    /** Step size for rolling forward (typically = testWindow for non-overlapping) */
    stepSize: number;
    /** Parameters to optimize with their ranges */
    parameterRanges: ParameterRange[];
    /** Number of top parameter sets to average (anchored selection) */
    topN?: number;
    /** Minimum trades required to consider a parameter set valid */
    minTrades?: number;
    /** Hard cap for generated parameter combinations (auto-sampled when exceeded) */
    maxCombinations?: number;
    /** Minimum OOS trades required for a window to count in robustness scoring */
    minOOSTradesPerWindow?: number;
    /** Minimum total OOS trades required before a result can be considered robust */
    minTotalOOSTrades?: number;
    /** Optional progress callback for UI feedback */
    onProgress?: (progress: WalkForwardProgress) => void;
}

export interface ParameterRange {
    name: string;
    min: number;
    max: number;
    step: number;
}

export interface WalkForwardWindow {
    /** Window index (0-based) */
    windowIndex: number;
    /** Start index of optimization period */
    optimizationStart: number;
    /** End index of optimization period (exclusive) */
    optimizationEnd: number;
    /** Start index of test period */
    testStart: number;
    /** End index of test period (exclusive) */
    testEnd: number;
    /** Best params found during optimization */
    optimizedParams: StrategyParams;
    /** In-sample (optimization) performance */
    inSampleResult: BacktestResult;
    /** Out-of-sample (test) performance */
    outOfSampleResult: BacktestResult;
    /** Performance degradation (IS Sharpe - OOS Sharpe) */
    sharpeDegradation: number;
    /** Performance degradation percentage */
    performanceDegradationPercent: number;
}

export interface WalkForwardResult {
    /** All walk-forward windows */
    windows: WalkForwardWindow[];
    /** Combined out-of-sample trades (the true performance) */
    combinedOOSTrades: BacktestResult;
    /** Average in-sample Sharpe ratio */
    avgInSampleSharpe: number;
    /** Average out-of-sample Sharpe ratio */
    avgOutOfSampleSharpe: number;
    /** Walk-Forward Efficiency Ratio (OOS/IS performance) */
    walkForwardEfficiency: number;
    /** Robustness Score (0-100) */
    robustnessScore: number;
    /** Number of windows tested */
    totalWindows: number;
    /** Total optimization time in ms */
    optimizationTimeMs: number;
    /** Parameter stability score (how consistent are optimal params) */
    parameterStability: number;
}

export type WalkForwardProgressPhase = 'optimize' | 'test' | 'window' | 'complete';

export interface WalkForwardProgress {
    phase: WalkForwardProgressPhase;
    windowIndex: number;
    totalWindows: number;
    comboIndex?: number;
    comboTotal?: number;
}

export interface OptimizationResult {
    params: StrategyParams;
    score: number;
}

type TradeSizing = {
    mode: 'percent' | 'fixed';
    fixedTradeAmount: number;
};

// ============================================================================
// Parameter Grid Generation
// ============================================================================

function validateRange(range: ParameterRange): void {
    if (!Number.isFinite(range.step) || range.step <= 0)
        throw new Error(`Invalid parameter step for ${range.name}: ${range.step}`);
    if (!Number.isFinite(range.min) || !Number.isFinite(range.max) || range.min >= range.max)
        throw new Error(`Invalid parameter range for ${range.name}: ${range.min} to ${range.max}`);
}

function generateParameterGrid(ranges: ParameterRange[]): StrategyParams[] {
    if (ranges.length === 0) return [{}];

    const grid: StrategyParams[] = [];

    function generate(index: number, current: StrategyParams): void {
        if (index >= ranges.length) {
            grid.push({ ...current });
            return;
        }

        const range = ranges[index];
        validateRange(range);

        // Guard against runaway loops on floating point ranges
        const maxIterations = Math.ceil((range.max - range.min) / range.step) + 2;
        let iterations = 0;
        for (let value = range.min; value <= range.max; value += range.step) {
            current[range.name] = Math.round(value * 1000) / 1000; // Avoid floating point issues
            generate(index + 1, current);
            iterations++;
            if (iterations > maxIterations) break;
        }
    }

    generate(0, {});
    return grid;
}

function estimateParameterGridSize(ranges: ParameterRange[]): number {
    if (ranges.length === 0) return 1;
    let estimate = 1;
    for (const range of ranges) {
        validateRange(range);
        const steps = Math.floor((range.max - range.min) / range.step) + 1;
        estimate *= Math.max(1, steps);
        if (!Number.isFinite(estimate)) {
            return Number.MAX_SAFE_INTEGER;
        }
    }
    return estimate;
}

function getRangeStepCount(range: ParameterRange): number {
    validateRange(range);
    return Math.max(1, Math.floor((range.max - range.min) / range.step) + 1);
}

function generateSampledParameterGrid(ranges: ParameterRange[], maxCombinations: number): StrategyParams[] {
    if (ranges.length === 0) return [{}];

    const target = Math.max(1, Math.floor(maxCombinations));
    const grid: StrategyParams[] = [];
    const seen = new Set<string>();
    const stepCounts = ranges.map(getRangeStepCount);

    const add = (params: StrategyParams) => {
        const key = ranges.map(range => `${range.name}:${params[range.name]}`).join('|');
        if (seen.has(key)) return false;
        seen.add(key);
        grid.push(params);
        return true;
    };

    // Seed with a deterministic midpoint combo.
    const midpoint: StrategyParams = {};
    for (const range of ranges) {
        midpoint[range.name] = Math.round((((range.min + range.max) / 2) * 1000)) / 1000;
    }
    add(midpoint);

    let attempts = 0;
    const maxAttempts = target * 30;
    while (grid.length < target && attempts < maxAttempts) {
        const params: StrategyParams = {};
        for (let i = 0; i < ranges.length; i++) {
            const range = ranges[i];
            const count = stepCounts[i];
            const idx = Math.floor(Math.random() * count);
            const value = range.min + idx * range.step;
            params[range.name] = Math.round(Math.min(range.max, value) * 1000) / 1000;
        }
        add(params);
        attempts++;
    }

    return grid;
}

// ============================================================================
// Scoring Function for Optimization
// ============================================================================

function calculateOptimizationScore(result: BacktestResult, minTrades: number): number {
    if (result.totalTrades < minTrades) {
        return -Infinity;
    }

    const sharpe = Math.max(-2, Math.min(2, sanitizeSharpeRatio(result.sharpeRatio)));
    const profitFactor = Number.isFinite(result.profitFactor)
        ? Math.min(result.profitFactor, 5) // Cap to avoid infinity skew
        : 0;
    const winRate = result.winRate / 100;
    const drawdownPenalty = Math.max(0, 1 - result.maxDrawdownPercent / 50);

    const score = (
        sharpe * 0.40 +
        profitFactor * 0.25 +
        winRate * 0.20 +
        drawdownPenalty * 0.15
    );

    return score;
}

// ============================================================================
// Window Backtest with Lookback (Internal Helper)
// ============================================================================


/**
 * Shared buffer + signal preparation for window backtests.
 */
function prepareWindowBacktest(
    data: OHLCVData[], startIndex: number, endIndex: number,
    strategy: Strategy, params: StrategyParams, lookback: number = 250
) {
    const bufferedStart = Math.max(0, startIndex - lookback);
    const bufferedData = data.slice(bufferedStart, endIndex);
    const allSignals = strategy.execute(bufferedData, params);
    const windowStartBar = data[startIndex];
    const windowEndBar = data[endIndex - 1];
    const windowSignals = allSignals.filter(s =>
        compareTime(s.time, windowStartBar.time) >= 0 && compareTime(s.time, windowEndBar.time) <= 0
    );
    return { bufferedStart, bufferedData, windowSignals, windowStartBar };
}

/**
 * Fast backtest runner for optimization loops.
 * Assumes data is already cleaned and indices are valid.
 */
function runBacktestFast(
    data: OHLCVData[], startIndex: number, endIndex: number,
    strategy: Strategy, params: StrategyParams,
    initialCapital: number, positionSizePercent: number, commissionPercent: number,
    backtestSettings: BacktestSettings, sizing?: TradeSizing, lookback: number = 250
): BacktestResult {
    const { bufferedStart, bufferedData, windowSignals, windowStartBar } =
        prepareWindowBacktest(data, startIndex, endIndex, strategy, params, lookback);

    const fullResult = runBacktest(bufferedData, windowSignals, initialCapital, positionSizePercent, commissionPercent, backtestSettings, sizing);

    const windowTrades = fullResult.trades.filter(t => compareTime(t.entryTime, windowStartBar.time) >= 0);
    const windowIndexOffset = startIndex - bufferedStart;
    const windowEquity = fullResult.equityCurve.slice(windowIndexOffset);
    const finalCapital = windowEquity.length > 0 ? windowEquity[windowEquity.length - 1].value : initialCapital;
    const { maxDrawdown, maxDrawdownPercent } = calculateMaxDrawdown(windowEquity, initialCapital);

    return calculateBacktestStats(windowTrades, windowEquity, initialCapital, finalCapital, maxDrawdown, maxDrawdownPercent);
}

function runBacktestFastCompact(
    data: OHLCVData[], startIndex: number, endIndex: number,
    strategy: Strategy, params: StrategyParams,
    initialCapital: number, positionSizePercent: number, commissionPercent: number,
    backtestSettings: BacktestSettings, sizing?: TradeSizing, lookback: number = 250
): BacktestResult {
    const { bufferedData, windowSignals } =
        prepareWindowBacktest(data, startIndex, endIndex, strategy, params, lookback);
    return runBacktestCompact(bufferedData, windowSignals, initialCapital, positionSizePercent, commissionPercent, backtestSettings, sizing);
}

function toSummaryResult(result: BacktestResult): BacktestResult {
    return {
        ...result,
        trades: [],
        equityCurve: []
    };
}

function selectScoringWindows(windows: WalkForwardWindow[], minOOSTradesPerWindow: number): WalkForwardWindow[] {
    const threshold = Math.max(0, Math.floor(minOOSTradesPerWindow));
    if (threshold <= 0) return windows;
    return windows.filter(window => window.outOfSampleResult.totalTrades >= threshold);
}

function averageSharpe(windows: WalkForwardWindow[], side: 'in' | 'out'): number {
    if (windows.length === 0) return 0;
    const values = windows.map(window =>
        side === 'in'
            ? window.inSampleResult.sharpeRatio
            : window.outOfSampleResult.sharpeRatio
    );
    const finite = values
        .filter(value => Number.isFinite(value))
        .map(value => sanitizeSharpeRatio(value));
    if (finite.length === 0) return 0;
    return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

// ============================================================================
// Window Optimization
// ============================================================================

async function optimizeWindow(
    data: OHLCVData[],
    startIndex: number,
    endIndex: number,
    strategy: Strategy,
    paramGrid: StrategyParams[],
    baseParams: StrategyParams,
    initialCapital: number,
    positionSizePercent: number,
    commissionPercent: number,
    backtestSettings: BacktestSettings,
    sizing: TradeSizing | undefined,
    minTrades: number,
    topN: number,
    onProgress?: (processed: number, total: number) => void
): Promise<OptimizationResult[]> {
    const topResults: OptimizationResult[] = [];
    // PERF: Increased batch size from 50 to 200 for less overhead
    const BATCH_SIZE = 200;
    // PERF: Yield every N batches instead of every batch
    const YIELD_INTERVAL = 3;
    // PERF: Early termination threshold - if top scores are stable, we can stop early
    const EARLY_TERM_CHECK_INTERVAL = 500;
    const EARLY_TERM_STABILITY_THRESHOLD = 5; // Number of stable checks before termination

    let batchCount = 0;
    let lastTopScore = -Infinity;
    let stableScoreCount = 0;
    let processedCount = 0;

    for (let i = 0; i < paramGrid.length; i += BATCH_SIZE) {
        const batchEnd = Math.min(i + BATCH_SIZE, paramGrid.length);
        batchCount++;

        // PERF: Yield less frequently - every YIELD_INTERVAL batches
        if (batchCount % YIELD_INTERVAL === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
            if (onProgress) {
                onProgress(Math.min(batchEnd, paramGrid.length), paramGrid.length);
            }
        }

        // Process batch without slice (avoid array allocation)
        for (let j = i; j < batchEnd; j++) {
            const paramOverrides = paramGrid[j];
            const params = { ...baseParams, ...paramOverrides };
            processedCount++;

            try {
                // Use compact backtest during optimization to keep memory stable.
                const result = runBacktestFastCompact(
                    data,
                    startIndex,
                    endIndex,
                    strategy,
                    params,
                    initialCapital,
                    positionSizePercent,
                    commissionPercent,
                    backtestSettings,
                    sizing
                );

                const score = calculateOptimizationScore(result, minTrades);

                if (Number.isFinite(score)) {
                    topResults.push({ params, score });
                }
            } catch (e) {
                continue;
            }
        }

        // Prune and sort periodically (less frequent than before)
        if (topResults.length > topN * 3) {
            topResults.sort((a, b) => b.score - a.score);
            topResults.splice(topN * 2);
        }

        // PERF: Early termination check - if we've processed enough and scores are stable
        if (processedCount >= EARLY_TERM_CHECK_INTERVAL && topResults.length >= topN) {
            topResults.sort((a, b) => b.score - a.score);
            const currentTopScore = topResults[0].score;

            // Check if top score has stabilized
            if (Math.abs(currentTopScore - lastTopScore) < 0.001) {
                stableScoreCount++;
                if (stableScoreCount >= EARLY_TERM_STABILITY_THRESHOLD && processedCount > paramGrid.length * 0.3) {
                    // Top score stable for N checks and we've processed at least 30% - early terminate
                    break;
                }
            } else {
                stableScoreCount = 0;
            }
            lastTopScore = currentTopScore;
        }
    }

    // Final sort and prune
    topResults.sort((a, b) => b.score - a.score);
    if (topResults.length > topN) {
        topResults.length = topN;
    }

    if (onProgress) {
        onProgress(paramGrid.length, paramGrid.length);
    }

    return topResults;
}

// ============================================================================
// Parameter Averaging (Anchored Selection)
// ============================================================================

function averageParameters(topResults: OptimizationResult[], ranges: ParameterRange[]): StrategyParams {
    if (topResults.length === 0) {
        const params: StrategyParams = {};
        for (const range of ranges) {
            params[range.name] = (range.min + range.max) / 2;
        }
        return params;
    }

    if (topResults.length === 1) {
        return { ...topResults[0].params };
    }

    const totalScore = topResults.reduce((sum, r) => sum + Math.max(0, r.score), 0);

    if (totalScore <= 0) {
        return { ...topResults[0].params };
    }

    const avgParams: StrategyParams = {};

    for (const range of ranges) {
        let weightedSum = 0;
        for (const r of topResults) {
            const weight = Math.max(0, r.score) / totalScore;
            weightedSum += (r.params[range.name] ?? 0) * weight;
        }
        avgParams[range.name] = Math.round(weightedSum / range.step) * range.step;
    }

    return avgParams;
}

// ============================================================================
// Parameter Stability Analysis
// ============================================================================

function calculateParameterStability(windows: WalkForwardWindow[], ranges: ParameterRange[]): number {
    if (windows.length < 2 || ranges.length === 0) return 100;

    let totalNormalizedVariance = 0;

    for (const range of ranges) {
        const values = windows.map(w => w.optimizedParams[range.name] ?? 0);
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;

        const rangeSpan = range.max - range.min;
        const normalizedStdDev = rangeSpan > 0 ? Math.sqrt(variance) / rangeSpan : 0;

        totalNormalizedVariance += normalizedStdDev;
    }

    const avgNormalizedStdDev = totalNormalizedVariance / ranges.length;
    return Math.max(0, Math.min(100, (1 - avgNormalizedStdDev * 2) * 100));
}

// ============================================================================
// Robustness Score Calculation
// ============================================================================

function calculateRobustnessScore(
    avgInSampleSharpe: number,
    avgOutOfSampleSharpe: number,
    parameterStability: number,
    windowResults: WalkForwardWindow[],
    combinedOOS: BacktestResult,
    minTotalOOSTrades: number
): number {
    if (windowResults.length === 0) return 0;
    if (combinedOOS.totalTrades <= 0) return 0;

    const requiredTrades = Math.max(1, Math.floor(minTotalOOSTrades));
    const tradeSufficiency = Math.min(1, combinedOOS.totalTrades / requiredTrades);

    // Walk-Forward Efficiency: OOS/IS Sharpe ratio with stability guards.
    const wfe = calculateWalkForwardEfficiency(avgInSampleSharpe, avgOutOfSampleSharpe);
    const wfeScore = Math.min(1, wfe) * 40;

    const stabilityScore = (parameterStability / 100) * 25;

    const positiveWindows = windowResults.filter(w => w.outOfSampleResult.netProfit > 0).length;
    const oosWinRate = windowResults.length > 0 ? positiveWindows / windowResults.length : 0;
    const oosWinScore = oosWinRate * 20;

    // Consistency score based on degradation variance
    const degradations = windowResults.map(w => w.performanceDegradationPercent);
    const validDegradations = degradations.filter(d => Number.isFinite(d));
    let consistencyScore = 0;
    if (validDegradations.length > 0) {
        const avgDegradation = validDegradations.reduce((a, b) => a + b, 0) / validDegradations.length;
        const degVariance = validDegradations.reduce((sum, d) => sum + Math.pow(d - avgDegradation, 2), 0) / validDegradations.length;
        const degStdDev = Math.sqrt(degVariance);
        consistencyScore = Math.max(0, 15 - degStdDev / 10);
    }

    const rawScore = wfeScore + stabilityScore + oosWinScore + consistencyScore;
    const adjustedScore = rawScore * tradeSufficiency;
    return Math.round(Math.max(0, Math.min(100, adjustedScore)));
}

function calculateWalkForwardEfficiency(avgInSampleSharpe: number, avgOutOfSampleSharpe: number): number {
    const inSharpe = sanitizeSharpeRatio(avgInSampleSharpe);
    const outSharpe = sanitizeSharpeRatio(avgOutOfSampleSharpe);

    if (inSharpe > 0.05) {
        return Math.max(0, Math.min(2, outSharpe / inSharpe));
    }

    if (inSharpe <= 0.05 && outSharpe > 0.05) {
        // If IS was flat/weak but OOS is genuinely positive, assign neutral efficiency.
        return 0.5;
    }

    return 0;
}


// ============================================================================
// Main Walk-Forward Analysis
// ============================================================================

export async function runWalkForwardAnalysis(
    data: OHLCVData[],
    strategy: Strategy,
    config: WalkForwardConfig,
    initialCapital: number,
    positionSizePercent: number,
    commissionPercent: number,
    backtestSettings: BacktestSettings = {},
    sizing?: TradeSizing
): Promise<WalkForwardResult> {
    const startTime = performance.now();

    // Clean input data to prevent crashes on undefined elements
    data = ensureCleanData(data);

    const {
        optimizationWindow,
        testWindow,
        stepSize,
        parameterRanges,
        topN = 3,
        minTrades = 5,
        maxCombinations = 5000,
        minOOSTradesPerWindow = 1,
        minTotalOOSTrades = 50,
        onProgress
    } = config;

    if (!Number.isFinite(optimizationWindow) || optimizationWindow <= 0) {
        throw new Error(`Invalid optimization window: ${optimizationWindow}`);
    }
    if (!Number.isFinite(testWindow) || testWindow <= 0) {
        throw new Error(`Invalid test window: ${testWindow}`);
    }
    if (!Number.isFinite(stepSize) || stepSize <= 0) {
        throw new Error(`Invalid step size: ${stepSize}`);
    }

    const estimatedGridSize = estimateParameterGridSize(parameterRanges);
    const comboCap = Math.max(100, Math.floor(maxCombinations));
    const shouldSample = estimatedGridSize > comboCap;
    const paramGrid = shouldSample
        ? generateSampledParameterGrid(parameterRanges, comboCap)
        : generateParameterGrid(parameterRanges);
    if (paramGrid.length === 0) {
        throw new Error('No parameter combinations generated. Check parameter ranges.');
    }
    if (shouldSample) {
        console.warn(`[WalkForward] Grid estimate ${estimatedGridSize} exceeds cap ${comboCap}; using random sample of ${paramGrid.length} combinations.`);
    }

    const totalDataLength = data.length;
    const windowSize = optimizationWindow + testWindow;
    const totalWindows = Math.floor((totalDataLength - windowSize) / stepSize) + 1;

    if (totalDataLength < windowSize) {
        throw new Error(`Insufficient data: need ${windowSize} bars minimum, have ${totalDataLength}`);
    }

    const windows: WalkForwardWindow[] = [];
    let currentStart = 0;
    let windowIndex = 0;
    let runningCapital = initialCapital;
    const combinedTrades: BacktestResult['trades'] = [];
    const combinedEquityCurve: { time: Time; value: number }[] = [];

    while (currentStart + windowSize <= totalDataLength) {
        const optimizationStart = currentStart;
        const optimizationEnd = currentStart + optimizationWindow;
        const testStart = optimizationEnd;
        const testEnd = Math.min(testStart + testWindow, totalDataLength);

        onProgress?.({
            phase: 'optimize',
            windowIndex,
            totalWindows
        });

        const topResults = await optimizeWindow(
            data,
            optimizationStart,
            optimizationEnd,
            strategy,
            paramGrid,
            strategy.defaultParams,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            backtestSettings,
            sizing,
            minTrades,
            topN,
            (processed, total) => onProgress?.({
                phase: 'optimize',
                windowIndex,
                totalWindows,
                comboIndex: processed,
                comboTotal: total
            })
        );

        const optimizedParams = averageParameters(topResults, parameterRanges);
        const finalParams = { ...strategy.defaultParams, ...optimizedParams };

        const inSampleResult = runBacktestFastCompact(
            data,
            optimizationStart,
            optimizationEnd,
            strategy,
            finalParams,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            backtestSettings,
            sizing
        );

        onProgress?.({
            phase: 'test',
            windowIndex,
            totalWindows
        });

        const outOfSampleDetailed = runBacktestFast(
            data,
            testStart,
            testEnd,
            strategy,
            finalParams,
            runningCapital,
            positionSizePercent,
            commissionPercent,
            backtestSettings,
            sizing
        );

        if (outOfSampleDetailed.equityCurve.length > 0) {
            runningCapital = outOfSampleDetailed.equityCurve[outOfSampleDetailed.equityCurve.length - 1].value;
        }
        combinedTrades.push(...outOfSampleDetailed.trades);
        combinedEquityCurve.push(...outOfSampleDetailed.equityCurve);

        const outOfSampleResult = toSummaryResult(outOfSampleDetailed);

        const sharpeDegradation = inSampleResult.sharpeRatio - outOfSampleResult.sharpeRatio;
        const performanceDegradationPercent = inSampleResult.netProfitPercent !== 0
            ? ((inSampleResult.netProfitPercent - outOfSampleResult.netProfitPercent) /
                Math.abs(inSampleResult.netProfitPercent)) * 100
            : 0;

        windows.push({
            windowIndex,
            optimizationStart,
            optimizationEnd,
            testStart,
            testEnd,
            optimizedParams: finalParams,
            inSampleResult: toSummaryResult(inSampleResult),
            outOfSampleResult,
            sharpeDegradation,
            performanceDegradationPercent
        });

        onProgress?.({
            phase: 'window',
            windowIndex,
            totalWindows
        });

        currentStart += stepSize;
        windowIndex++;
    }

    if (windows.length === 0) {
        throw new Error('No walk-forward windows could be created.');
    }

    const finalCapital = combinedEquityCurve.length > 0
        ? combinedEquityCurve[combinedEquityCurve.length - 1].value
        : initialCapital;
    const { maxDrawdown, maxDrawdownPercent } = calculateMaxDrawdown(combinedEquityCurve, initialCapital);
    const combinedOOSTrades = calculateBacktestStats(
        combinedTrades,
        combinedEquityCurve,
        initialCapital,
        finalCapital,
        maxDrawdown,
        maxDrawdownPercent
    );

    const scoringWindows = selectScoringWindows(windows, minOOSTradesPerWindow);
    const avgInSampleSharpe = averageSharpe(scoringWindows, 'in');
    const avgOutOfSampleSharpe = averageSharpe(scoringWindows, 'out');

    const walkForwardEfficiency = calculateWalkForwardEfficiency(avgInSampleSharpe, avgOutOfSampleSharpe);
    const parameterStability = calculateParameterStability(scoringWindows, parameterRanges);
    const robustnessScore = calculateRobustnessScore(
        avgInSampleSharpe,
        avgOutOfSampleSharpe,
        parameterStability,
        scoringWindows,
        combinedOOSTrades,
        minTotalOOSTrades
    );

    const endTime = performance.now();

    onProgress?.({
        phase: 'complete',
        windowIndex: Math.max(0, totalWindows - 1),
        totalWindows
    });

    return {
        windows,
        combinedOOSTrades,
        avgInSampleSharpe,
        avgOutOfSampleSharpe,
        walkForwardEfficiency,
        robustnessScore,
        totalWindows: windows.length,
        optimizationTimeMs: endTime - startTime,
        parameterStability
    };
}

export async function quickWalkForward(
    data: OHLCVData[],
    strategy: Strategy,
    initialCapital: number = 10000,
    positionSizePercent: number = 100,
    commissionPercent: number = 0.1,
    backtestSettings: BacktestSettings = {},
    sizing?: TradeSizing,
    onProgress?: (progress: WalkForwardProgress) => void
): Promise<WalkForwardResult> {
    // Clean data at the entry point
    data = ensureCleanData(data);

    const totalBars = data.length;
    // Keep quick mode bounded on very large datasets.
    const targetWindows = totalBars >= 6000 ? 4 : 5;
    const testRatio = 0.30;

    const windowSize = Math.floor(totalBars / targetWindows);
    const testWindow = Math.max(20, Math.floor(windowSize * testRatio));
    const optimizationWindow = Math.max(50, windowSize - testWindow);

    const allowedParams = strategy.metadata?.walkForwardParams;
    const allowSet = allowedParams ? new Set(allowedParams) : null;
    const tunableParamEntries = Object.entries(strategy.defaultParams)
        .filter(([name]) => !allowSet || allowSet.has(name));

    // Strict quick-mode optimization budget.
    const tunableParamCount = Math.max(1, tunableParamEntries.length);
    const maxCombinations = Math.min(600, Math.max(150, tunableParamCount * 40));
    // Steps = TargetIterations ^ (1 / paramCount).
    const targetTotalIterations = Math.max(60, Math.floor(maxCombinations * 0.6));
    const stepsPerParam = Math.max(2, Math.floor(Math.pow(targetTotalIterations, 1 / tunableParamCount)));

    const parameterRanges: ParameterRange[] = [];
    for (const [name, defaultValue] of tunableParamEntries) {
        const isToggle = /^use[A-Z]/.test(name) && (defaultValue === 0 || defaultValue === 1);
        if (isToggle) {
            parameterRanges.push({ name, min: 0, max: 1, step: 1 });
            continue;
        }

        // Handle decimal parameters (like Fib levels 0.618, 0.382) differently from integer params
        const isDecimal = !Number.isInteger(defaultValue) && defaultValue < 1;

        let min: number;
        let max: number;
        let step: number;

        if (isDecimal) {
            // For decimal params between 0-1 (like Fib ratios), use proportional range
            min = Math.max(0.1, defaultValue * 0.5);
            max = Math.min(1.0, defaultValue * 1.5);
            // Ensure at least 2 steps, but keep step reasonable for decimals
            const rawStep = (max - min) / stepsPerParam;
            step = Math.max(0.05, rawStep);
        } else {
            // For integer-like params
            min = Math.max(1, Math.floor(defaultValue * 0.5));
            max = Math.ceil(defaultValue * 2);
            const rawStep = (max - min) / stepsPerParam;
            step = Math.max(1, rawStep);
        }

        // Skip parameters where min >= max (invalid range)
        if (min >= max) {
            continue;
        }

        parameterRanges.push({ name, min, max, step });
    }

    return runWalkForwardAnalysis(
        data,
        strategy,
        {
            optimizationWindow,
            testWindow,
            stepSize: testWindow,
            parameterRanges,
            topN: 2,
            minTrades: 2,
            maxCombinations,
            onProgress
        },
        initialCapital,
        positionSizePercent,
        commissionPercent,
        backtestSettings,
        sizing
    );
}

// ============================================================================
// Fixed-Parameter Walk-Forward (for strategies without tunable parameters)
// ============================================================================
//
// This function runs walk-forward analysis for strategies without tunable
// parameters. Instead of optimizing parameters in each window, it runs 
// the SAME fixed strategy across all windows. This is useful for testing 
// robustness of a strategy to see if it performs consistently across 
// different time periods.
//
// The key difference from regular WFA:
// - No parameter optimization grid is generated
// - The strategy runs with its fixed configuration across all windows
// - Robustness is measured by consistency across time periods, not
//   by how well optimized params transfer to OOS periods
//
// ============================================================================

export interface FixedParamWalkForwardConfig {
    /** Number of bars in each test window */
    testWindow: number;
    /** Step size for rolling forward (typically = testWindow for non-overlapping) */
    stepSize: number;
    /** Minimum trades required to consider a window valid */
    minTrades?: number;
    /** Optional progress callback for UI feedback */
    onProgress?: (progress: WalkForwardProgress) => void;
}

/**
 * Run walk-forward analysis for a fixed-parameter strategy.
 * Instead of doing parameter optimization, this tests the exact same strategy
 * configuration across multiple time windows to check for consistency/robustness.
 */
export async function runFixedParamWalkForward(
    data: OHLCVData[],
    strategy: Strategy,
    config: FixedParamWalkForwardConfig,
    initialCapital: number,
    positionSizePercent: number,
    commissionPercent: number,
    backtestSettings: BacktestSettings = {},
    sizing?: TradeSizing
): Promise<WalkForwardResult> {
    const startTime = performance.now();

    // Clean input data
    data = ensureCleanData(data);

    const { testWindow, stepSize, minTrades = 1, onProgress } = config;
    if (!Number.isFinite(testWindow) || testWindow <= 0) {
        throw new Error(`Invalid test window: ${testWindow}`);
    }
    if (!Number.isFinite(stepSize) || stepSize <= 0) {
        throw new Error(`Invalid step size: ${stepSize}`);
    }

    const totalDataLength = data.length;

    if (totalDataLength < testWindow * 2) {
        throw new Error(`Insufficient data: need at least ${testWindow * 2} bars for walk-forward, have ${totalDataLength}`);
    }

    const windows: WalkForwardWindow[] = [];
    let currentStart = 0;
    let windowIndex = 0;
    let runningCapital = initialCapital;
    const combinedTrades: BacktestResult['trades'] = [];
    const combinedEquityCurve: { time: Time; value: number }[] = [];

    // Fixed params - use whatever the strategy has
    const fixedParams = strategy.defaultParams;

    const totalWindows = Math.floor((totalDataLength - testWindow) / stepSize) + 1;

    while (currentStart + testWindow <= totalDataLength) {
        const windowStart = currentStart;
        const windowEnd = Math.min(currentStart + testWindow, totalDataLength);

        // For fixed-param WFA, we treat "In-Sample" and "Out-of-Sample" differently:
        // Since there's no optimization, we split each window in half to get IS/OOS metrics
        // This gives us a way to measure consistency within each window
        const midPoint = windowStart + Math.floor((windowEnd - windowStart) / 2);

        // PERF: Use fast backtest - data is already cleaned at entry point
        // First half = "In-Sample" (what we'd train on if we had params)
        const inSampleResult = runBacktestFastCompact(
            data,
            windowStart,
            midPoint,
            strategy,
            fixedParams,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            backtestSettings,
            sizing
        );

        // Second half = "Out-of-Sample" (the forward test)
        const outOfSampleDetailed = runBacktestFast(
            data,
            midPoint,
            windowEnd,
            strategy,
            fixedParams,
            runningCapital,
            positionSizePercent,
            commissionPercent,
            backtestSettings,
            sizing
        );

        // Update running capital for next window
        if (outOfSampleDetailed.equityCurve.length > 0) {
            runningCapital = outOfSampleDetailed.equityCurve[outOfSampleDetailed.equityCurve.length - 1].value;
        }
        combinedTrades.push(...outOfSampleDetailed.trades);
        combinedEquityCurve.push(...outOfSampleDetailed.equityCurve);
        const outOfSampleResult = toSummaryResult(outOfSampleDetailed);

        // Calculate degradation metrics
        const sharpeDegradation = inSampleResult.sharpeRatio - outOfSampleResult.sharpeRatio;
        const performanceDegradationPercent = inSampleResult.netProfitPercent !== 0
            ? ((inSampleResult.netProfitPercent - outOfSampleResult.netProfitPercent) /
                Math.abs(inSampleResult.netProfitPercent)) * 100
            : 0;

        // Include ALL windows - even 0 trades is valid data (strategy didn't trigger)
        windows.push({
            windowIndex,
            optimizationStart: windowStart,
            optimizationEnd: midPoint,
            testStart: midPoint,
            testEnd: windowEnd,
            optimizedParams: fixedParams,
            inSampleResult: toSummaryResult(inSampleResult),
            outOfSampleResult,
            sharpeDegradation,
            performanceDegradationPercent
        });

        onProgress?.({
            phase: 'window',
            windowIndex,
            totalWindows
        });
        windowIndex++;

        currentStart += stepSize;

        // PERF: Yield less frequently - every 10 windows instead of every 5
        if (windowIndex > 0 && windowIndex % 10 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    if (windows.length === 0) {
        throw new Error(`No walk-forward windows could be created. Data length: ${totalDataLength}, window size: ${testWindow}. Try reducing window size.`);
    }


    const finalCapital = combinedEquityCurve.length > 0
        ? combinedEquityCurve[combinedEquityCurve.length - 1].value
        : initialCapital;
    const { maxDrawdown, maxDrawdownPercent } = calculateMaxDrawdown(combinedEquityCurve, initialCapital);
    const combinedOOSTrades = calculateBacktestStats(
        combinedTrades,
        combinedEquityCurve,
        initialCapital,
        finalCapital,
        maxDrawdown,
        maxDrawdownPercent
    );

    // Calculate aggregate metrics on trade-active windows only.
    const scoringWindows = selectScoringWindows(windows, minTrades);
    const avgInSampleSharpe = averageSharpe(scoringWindows, 'in');
    const avgOutOfSampleSharpe = averageSharpe(scoringWindows, 'out');

    const walkForwardEfficiency = calculateWalkForwardEfficiency(avgInSampleSharpe, avgOutOfSampleSharpe);

    // For fixed params, stability is 100% (no variation)
    const parameterStability = 100;

    const robustnessScore = calculateRobustnessScore(
        avgInSampleSharpe,
        avgOutOfSampleSharpe,
        parameterStability,
        scoringWindows,
        combinedOOSTrades,
        20
    );

    const endTime = performance.now();

    onProgress?.({
        phase: 'complete',
        windowIndex: Math.max(0, totalWindows - 1),
        totalWindows
    });

    return {
        windows,
        combinedOOSTrades,
        avgInSampleSharpe,
        avgOutOfSampleSharpe,
        walkForwardEfficiency,
        robustnessScore,
        totalWindows: windows.length,
        optimizationTimeMs: endTime - startTime,
        parameterStability
    };
}

export function formatWalkForwardSummary(result: WalkForwardResult): string {
    const lines: string[] = [
        '═══════════════════════════════════════════════════════════════',
        '                    WALK-FORWARD ANALYSIS RESULTS              ',
        '═══════════════════════════════════════════════════════════════',
        '',
        `Total Windows:            ${result.totalWindows}`,
        `Optimization Time:        ${(result.optimizationTimeMs / 1000).toFixed(2)}s`,
        '',
        '─────────────────────────────────────────────────────────────────',
        '                         PERFORMANCE METRICS                    ',
        '─────────────────────────────────────────────────────────────────',
        '',
        `Avg In-Sample Sharpe:     ${result.avgInSampleSharpe.toFixed(3)}`,
        `Avg Out-of-Sample Sharpe: ${result.avgOutOfSampleSharpe.toFixed(3)}`,
        `Walk-Forward Efficiency:  ${(result.walkForwardEfficiency * 100).toFixed(1)}%`,
        '',
        `Combined OOS Net Profit:  $${result.combinedOOSTrades.netProfit.toFixed(2)} (${result.combinedOOSTrades.netProfitPercent.toFixed(1)}%)`,
        `Combined OOS Win Rate:    ${result.combinedOOSTrades.winRate.toFixed(1)}%`,
        `Combined OOS Profit Factor: ${result.combinedOOSTrades.profitFactor.toFixed(2)}`,
        `Combined OOS Max Drawdown: ${result.combinedOOSTrades.maxDrawdownPercent.toFixed(1)}%`,
        `Combined OOS Total Trades: ${result.combinedOOSTrades.totalTrades}`,
        '',
        '─────────────────────────────────────────────────────────────────',
        '                         ROBUSTNESS ANALYSIS                    ',
        '─────────────────────────────────────────────────────────────────',
        '',
        `Robustness Score:         ${result.robustnessScore}/100`,
        `Parameter Stability:      ${result.parameterStability.toFixed(1)}%`,
        '',
        getScoreInterpretation(result.robustnessScore),
        '',
        '─────────────────────────────────────────────────────────────────',
        '                         WINDOW BREAKDOWN                       ',
        '─────────────────────────────────────────────────────────────────',
        ''
    ];

    for (const window of result.windows) {
        const isProfit = window.outOfSampleResult.netProfit >= 0 ? '✓' : '✗';
        lines.push(
            `Window ${window.windowIndex + 1}: IS: ${window.inSampleResult.netProfitPercent.toFixed(1)}% → OOS: ${window.outOfSampleResult.netProfitPercent.toFixed(1)}% ${isProfit}  (Degradation: ${window.performanceDegradationPercent.toFixed(0)}%)`
        );
    }

    lines.push('');
    lines.push('═══════════════════════════════════════════════════════════════');
    return lines.join('\n');
}

function getScoreInterpretation(score: number): string {
    if (score >= 80) return '🟢 EXCELLENT: Strategy shows strong robustness. Low overfitting risk.';
    if (score >= 60) return '🟡 GOOD: Strategy is reasonably robust. Monitor for degradation.';
    if (score >= 40) return '🟠 MODERATE: Some overfitting detected. Consider parameter constraints.';
    if (score >= 20) return '🔴 POOR: Significant overfitting. Strategy may not perform forward.';
    return '⛔ CRITICAL: Severe overfitting. Strategy is curve-fitted and unreliable.';
}


