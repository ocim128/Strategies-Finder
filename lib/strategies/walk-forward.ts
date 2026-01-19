import { OHLCVData, BacktestResult, StrategyParams, BacktestSettings, Strategy, Time } from './types';
import { runBacktest, calculateBacktestStats, calculateMaxDrawdown, compareTime } from './backtest';
import { ensureCleanData } from './strategy-helpers';

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

export interface OptimizationResult {
    params: StrategyParams;
    result: BacktestResult;
    score: number;
}

// ============================================================================
// Parameter Grid Generation
// ============================================================================

function generateParameterGrid(ranges: ParameterRange[]): StrategyParams[] {
    if (ranges.length === 0) return [{}];

    const grid: StrategyParams[] = [];

    function generate(index: number, current: StrategyParams): void {
        if (index >= ranges.length) {
            grid.push({ ...current });
            return;
        }

        const range = ranges[index];
        for (let value = range.min; value <= range.max; value += range.step) {
            current[range.name] = Math.round(value * 1000) / 1000; // Avoid floating point issues
            generate(index + 1, current);
        }
    }

    generate(0, {});
    return grid;
}

// ============================================================================
// Scoring Function for Optimization
// ============================================================================

function calculateOptimizationScore(result: BacktestResult, minTrades: number): number {
    if (result.totalTrades < minTrades) {
        return -Infinity;
    }

    const sharpe = Number.isFinite(result.sharpeRatio) ? result.sharpeRatio : 0;
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


function runBacktestWithLookback(
    data: OHLCVData[],
    startIndex: number,
    endIndex: number,
    strategy: Strategy,
    params: StrategyParams,
    initialCapital: number,
    positionSizePercent: number,
    commissionPercent: number,
    backtestSettings: BacktestSettings,
    lookback: number = 250
): BacktestResult {
    // Clean data once at the start of the window operation
    data = ensureCleanData(data);

    // Validate indices
    if (startIndex < 0 || endIndex > data.length || startIndex >= endIndex) {
        throw new Error(`Invalid window indices: startIndex=${startIndex}, endIndex=${endIndex}, dataLength=${data.length}`);
    }

    const bufferedStart = Math.max(0, startIndex - lookback);
    const bufferedData = data.slice(bufferedStart, endIndex);

    // Validate buffered data
    if (bufferedData.length === 0) {
        throw new Error(`Empty buffered data: bufferedStart=${bufferedStart}, endIndex=${endIndex}`);
    }

    const allSignals = strategy.execute(bufferedData, params);

    const windowStartBar = data[startIndex];
    const windowEndBar = data[endIndex - 1];

    const windowSignals = allSignals.filter(s => {
        return compareTime(s.time, windowStartBar.time) >= 0 && compareTime(s.time, windowEndBar.time) <= 0;
    });

    const fullResult = runBacktest(
        bufferedData,
        windowSignals,
        initialCapital,
        positionSizePercent,
        commissionPercent,
        backtestSettings
    );

    const windowTrades = fullResult.trades.filter(t => compareTime(t.entryTime, windowStartBar.time) >= 0);
    const windowIndexOffset = startIndex - bufferedStart;
    const windowEquity = fullResult.equityCurve.slice(windowIndexOffset);

    const finalCapital = windowEquity.length > 0 ? windowEquity[windowEquity.length - 1].value : initialCapital;
    const { maxDrawdown, maxDrawdownPercent } = calculateMaxDrawdown(windowEquity, initialCapital);

    return calculateBacktestStats(
        windowTrades,
        windowEquity,
        initialCapital,
        finalCapital,
        maxDrawdown,
        maxDrawdownPercent
    );
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
    minTrades: number,
    topN: number
): Promise<OptimizationResult[]> {
    const topResults: OptimizationResult[] = [];
    const BATCH_SIZE = 50; // Process 50 combinations before yielding

    for (let i = 0; i < paramGrid.length; i += BATCH_SIZE) {
        const batch = paramGrid.slice(i, i + BATCH_SIZE);

        // Yield to event loop to prevent freezing
        if (i > 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        for (const paramOverrides of batch) {
            const params = { ...baseParams, ...paramOverrides };

            try {
                const result = runBacktestWithLookback(
                    data,
                    startIndex,
                    endIndex,
                    strategy,
                    params,
                    initialCapital,
                    positionSizePercent,
                    commissionPercent,
                    backtestSettings
                );

                const score = calculateOptimizationScore(result, minTrades);

                if (Number.isFinite(score)) {
                    topResults.push({ params, result, score });
                }
            } catch (e) {
                continue;
            }
        }

        // Sort and prune intermediate results to keep memory usage low
        topResults.sort((a, b) => b.score - a.score);
        if (topResults.length > topN * 2) {
            // Keep a bit more than topN to allow for some churn, but prune heavily
            topResults.splice(topN * 2);
        }
    }

    // Final prune
    if (topResults.length > topN) {
        topResults.length = topN;
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
    windowResults: WalkForwardWindow[]
): number {
    const wfe = avgInSampleSharpe > 0
        ? Math.min(1, avgOutOfSampleSharpe / avgInSampleSharpe)
        : 0;
    const wfeScore = wfe * 40;

    const stabilityScore = (parameterStability / 100) * 25;

    const positiveWindows = windowResults.filter(w => w.outOfSampleResult.netProfit > 0).length;
    const oosWinRate = windowResults.length > 0 ? positiveWindows / windowResults.length : 0;
    const oosWinScore = oosWinRate * 20;

    const degradations = windowResults.map(w => w.performanceDegradationPercent);
    const avgDegradation = degradations.reduce((a, b) => a + b, 0) / degradations.length;
    const degVariance = degradations.reduce((sum, d) => sum + Math.pow(d - avgDegradation, 2), 0) / degradations.length;
    const degStdDev = Math.sqrt(degVariance);
    const consistencyScore = Math.max(0, 15 - degStdDev / 10);

    return Math.round(wfeScore + stabilityScore + oosWinScore + consistencyScore);
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
    backtestSettings: BacktestSettings = {}
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
        minTrades = 5
    } = config;

    const paramGrid = generateParameterGrid(parameterRanges);

    if (paramGrid.length === 0) {
        throw new Error('No parameter combinations generated. Check parameter ranges.');
    }

    // Safety check - increased limit because we are now async/chunked
    if (paramGrid.length > 200000) {
        throw new Error(`Optimization grid too large: ${paramGrid.length} combinations. This will take too long. Please reduce parameter ranges.`);
    }

    const totalDataLength = data.length;
    const windowSize = optimizationWindow + testWindow;

    if (totalDataLength < windowSize) {
        throw new Error(`Insufficient data: need ${windowSize} bars minimum, have ${totalDataLength}`);
    }

    const windows: WalkForwardWindow[] = [];
    let currentStart = 0;
    let windowIndex = 0;
    let runningCapital = initialCapital;

    while (currentStart + windowSize <= totalDataLength) {
        const optimizationStart = currentStart;
        const optimizationEnd = currentStart + optimizationWindow;
        const testStart = optimizationEnd;
        const testEnd = Math.min(testStart + testWindow, totalDataLength);

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
            minTrades,
            topN
        );

        const optimizedParams = averageParameters(topResults, parameterRanges);
        const finalParams = { ...strategy.defaultParams, ...optimizedParams };

        const inSampleResult = runBacktestWithLookback(
            data,
            optimizationStart,
            optimizationEnd,
            strategy,
            finalParams,
            initialCapital,
            positionSizePercent,
            commissionPercent,
            backtestSettings
        );

        const outOfSampleResult = runBacktestWithLookback(
            data,
            testStart,
            testEnd,
            strategy,
            finalParams,
            runningCapital,
            positionSizePercent,
            commissionPercent,
            backtestSettings
        );

        if (outOfSampleResult.equityCurve.length > 0) {
            runningCapital = outOfSampleResult.equityCurve[outOfSampleResult.equityCurve.length - 1].value;
        }

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
            inSampleResult,
            outOfSampleResult,
            sharpeDegradation,
            performanceDegradationPercent
        });

        currentStart += stepSize;
        windowIndex++;
    }

    if (windows.length === 0) {
        throw new Error('No walk-forward windows could be created.');
    }

    const combinedOOSTrades = combineOOSResults(windows, initialCapital);

    const avgInSampleSharpe = windows.reduce((sum, w) => sum + w.inSampleResult.sharpeRatio, 0) / windows.length;
    const avgOutOfSampleSharpe = windows.reduce((sum, w) => sum + w.outOfSampleResult.sharpeRatio, 0) / windows.length;

    const walkForwardEfficiency = avgInSampleSharpe > 0 ? avgOutOfSampleSharpe / avgInSampleSharpe : 0;
    const parameterStability = calculateParameterStability(windows, parameterRanges);
    const robustnessScore = calculateRobustnessScore(avgInSampleSharpe, avgOutOfSampleSharpe, parameterStability, windows);

    const endTime = performance.now();

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

function combineOOSResults(windows: WalkForwardWindow[], initialCapital: number): BacktestResult {
    const allTrades = windows.flatMap(w => w.outOfSampleResult.trades);
    const combinedEquityCurve: { time: Time; value: number }[] = [];

    // The outOfSampleResults already have continuous capital because we passed runningCapital
    for (const window of windows) {
        combinedEquityCurve.push(...window.outOfSampleResult.equityCurve);
    }

    const finalCapital = combinedEquityCurve.length > 0 ? combinedEquityCurve[combinedEquityCurve.length - 1].value : initialCapital;
    const { maxDrawdown, maxDrawdownPercent } = calculateMaxDrawdown(combinedEquityCurve, initialCapital);

    return calculateBacktestStats(
        allTrades,
        combinedEquityCurve,
        initialCapital,
        finalCapital,
        maxDrawdown,
        maxDrawdownPercent
    );
}

export async function quickWalkForward(
    data: OHLCVData[],
    strategy: Strategy,
    initialCapital: number = 10000,
    positionSizePercent: number = 100,
    commissionPercent: number = 0.1
): Promise<WalkForwardResult> {
    // Clean data at the entry point
    data = ensureCleanData(data);

    const totalBars = data.length;
    const targetWindows = 5;
    const testRatio = 0.30;

    const windowSize = Math.floor(totalBars / targetWindows);
    const testWindow = Math.max(20, Math.floor(windowSize * testRatio));
    const optimizationWindow = Math.max(50, windowSize - testWindow);

    // Dynamic step calculation to prevent explosion
    const numParams = Object.keys(strategy.defaultParams).length;
    // Target approx 100-200 iterations total to be "quick"
    const targetTotalIterations = 200;

    // Steps = Target ^ (1/KPI)
    // We want at least 2 steps per param usually, but if many params, strictly limit.
    // effectiveSteps takes into account that we iterate all params.
    const stepsPerParam = Math.max(2, Math.floor(Math.pow(targetTotalIterations, 1 / Math.max(1, numParams))));

    const parameterRanges: ParameterRange[] = [];
    for (const [name, defaultValue] of Object.entries(strategy.defaultParams)) {
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
            topN: 3,
            minTrades: 3
        },
        initialCapital,
        positionSizePercent,
        commissionPercent
    );
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
