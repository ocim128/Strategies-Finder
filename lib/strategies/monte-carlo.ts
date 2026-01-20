import { OHLCVData, BacktestResult, Trade, StrategyParams, BacktestSettings, Strategy } from './types';
import { runBacktest } from './backtest';
import { ensureCleanData } from './strategy-helpers';

// ============================================================================
// Monte-Carlo Robustness Lab Module
// ============================================================================
//
// Theory of Operation:
// Monte-Carlo simulation tests how robust a strategy is to random variations
// and market noise. Unlike a single backtest that gives one result, MC gives
// a distribution of possible outcomes to detect overfitting and fragility.
//
// Methods:
// 1. Trade Resampling (Bootstrap): Randomly sample trades with replacement
//    to see how equity curves could have looked with different trade sequences.
// 2. Block Bootstrap: Resample blocks of bars (preserving autocorrelation)
//    to test sensitivity to data ordering.
// 3. Return Shuffling: Shuffle trade returns to test sequence dependency.
// 4. Shock Simulation: Add random slippage/spread/latency to test fragility.
//
// Key Metrics:
// - Probability of Profit: % of simulations that end profitable
// - Percentile Net Profits: 5th, 50th, 95th percentile outcomes
// - Max Drawdown Distribution: Range of worst-case scenarios
// - PSR (Probabilistic Sharpe Ratio): Probability that Sharpe > 0
// - Deflated Sharpe: Sharpe adjusted for multiple testing bias
//
// ============================================================================

export interface MonteCarloConfig {
    /** Number of simulation runs */
    simulations: number;
    /** Bootstrap block size for block bootstrap (0 = trade-level bootstrap) */
    blockSize: number;
    /** Slippage range in basis points (e.g., 5 = 0.05%) */
    slippageBps: number;
    /** Spread shock range in basis points */
    spreadBps: number;
    /** Random latency range in bars (0 = no latency) */
    latencyBars: number;
    /** Confidence level for percentiles (default 0.95 = 95%) */
    confidenceLevel: number;
    /** Minimum trades required for valid simulation */
    minTrades: number;
}

export interface SimulationResult {
    /** Net profit for this simulation */
    netProfit: number;
    /** Net profit percent for this simulation */
    netProfitPercent: number;
    /** Max drawdown percent for this simulation */
    maxDrawdownPercent: number;
    /** Sharpe ratio for this simulation */
    sharpeRatio: number;
    /** Profit factor for this simulation */
    profitFactor: number;
    /** Win rate for this simulation */
    winRate: number;
    /** Total trades in this simulation */
    totalTrades: number;
}

export interface MonteCarloResult {
    /** All individual simulation results */
    simulations: SimulationResult[];
    /** Number of simulations run */
    totalSimulations: number;
    /** Original backtest result for comparison */
    originalResult: BacktestResult;

    // === Probability Metrics ===
    /** Probability of ending profitable (0-100%) */
    probabilityOfProfit: number;
    /** Probability of beating original result */
    probabilityBeatOriginal: number;

    // === Net Profit Distribution ===
    netProfit5th: number;
    netProfit25th: number;
    netProfit50th: number;
    netProfit75th: number;
    netProfit95th: number;
    netProfitMean: number;
    netProfitStdDev: number;

    // === Max Drawdown Distribution ===
    maxDD5th: number;
    maxDD50th: number;
    maxDD95th: number;
    maxDDMean: number;

    // === Sharpe Distribution ===
    sharpe5th: number;
    sharpe50th: number;
    sharpe95th: number;
    sharpeMean: number;

    // === Advanced Metrics ===
    /** Probabilistic Sharpe Ratio: P(Sharpe > 0) */
    probabilisticSharpeRatio: number;
    /** Deflated Sharpe Ratio: Adjusted for multiple testing */
    deflatedSharpeRatio: number;
    /** Tail ratio: 95th percentile loss / 50th percentile profit */
    tailRatio: number;

    // === Robustness Score ===
    /** Overall robustness score (0-100) */
    robustnessScore: number;
    /** Fragility index: How sensitive to noise (0-100, lower is better) */
    fragilityIndex: number;

    /** Time taken for simulation in ms */
    simulationTimeMs: number;
}

// ============================================================================
// Utility Functions
// ============================================================================

function sampleWithReplacement<T>(arr: T[], count: number): T[] {
    const result: T[] = [];
    for (let i = 0; i < count; i++) {
        result.push(arr[Math.floor(Math.random() * arr.length)]);
    }
    return result;
}

function blockBootstrap<T>(arr: T[], blockSize: number, targetLength: number): T[] {
    if (blockSize <= 0) blockSize = 1;
    const result: T[] = [];
    while (result.length < targetLength) {
        const startIdx = Math.floor(Math.random() * arr.length);
        for (let i = 0; i < blockSize && result.length < targetLength; i++) {
            const idx = (startIdx + i) % arr.length;
            result.push(arr[idx]);
        }
    }
    return result;
}

function percentile(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * p);
    return sorted[Math.min(idx, sorted.length - 1)];
}

function mean(arr: number[]): number {
    if (arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr: number[]): number {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    const variance = arr.reduce((sum, x) => sum + Math.pow(x - m, 2), 0) / (arr.length - 1);
    return Math.sqrt(variance);
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

// ============================================================================
// Trade-Level Monte Carlo (Bootstrap)
// ============================================================================

function simulateTradeBootstrap(
    trades: Trade[],
    initialCapital: number,
    config: MonteCarloConfig
): SimulationResult {
    if (trades.length === 0) {
        return {
            netProfit: 0,
            netProfitPercent: 0,
            maxDrawdownPercent: 0,
            sharpeRatio: 0,
            profitFactor: 0,
            winRate: 0,
            totalTrades: 0
        };
    }

    // Sample trades with replacement
    const sampledTrades = sampleWithReplacement(trades, trades.length);

    // Apply random slippage/spread shocks
    const adjustedTrades = sampledTrades.map((trade, idx) => {
        const slippageFactor = 1 + (Math.random() - 0.5) * 2 * (config.slippageBps / 10000);
        const spreadCost = trade.entryPrice * (config.spreadBps / 10000);

        const adjustedPnl = trade.pnl * slippageFactor - spreadCost;

        return {
            ...trade,
            id: idx + 1,
            pnl: adjustedPnl,
            pnlPercent: (adjustedPnl / (trade.size * trade.entryPrice)) * 100
        };
    });

    // Calculate metrics
    return calculateSimulationStats(adjustedTrades, initialCapital);
}

function calculateSimulationStats(trades: Trade[], initialCapital: number): SimulationResult {
    const winningTrades = trades.filter(t => t.pnl > 0);
    const losingTrades = trades.filter(t => t.pnl <= 0);

    const totalProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0);
    const totalLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0));
    const netProfit = totalProfit - totalLoss;

    // Simulate equity curve for drawdown
    let equity = initialCapital;
    let peak = equity;
    let maxDrawdown = 0;

    for (const trade of trades) {
        equity += trade.pnl;
        if (equity > peak) peak = equity;
        const drawdown = (peak - equity) / peak;
        if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    const returns = trades.map(t => t.pnlPercent);
    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const stdReturn = returns.length > 1
        ? Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1))
        : 0;
    const sharpeRatio = stdReturn > 0 ? avgReturn / stdReturn : 0;

    return {
        netProfit,
        netProfitPercent: (netProfit / initialCapital) * 100,
        maxDrawdownPercent: maxDrawdown * 100,
        sharpeRatio,
        profitFactor: totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0,
        winRate: trades.length > 0 ? (winningTrades.length / trades.length) * 100 : 0,
        totalTrades: trades.length
    };
}

// ============================================================================
// Bar-Level Block Bootstrap Monte Carlo
// ============================================================================

async function simulateBlockBootstrap(
    data: OHLCVData[],
    strategy: Strategy,
    params: StrategyParams,
    initialCapital: number,
    positionSizePercent: number,
    commissionPercent: number,
    backtestSettings: BacktestSettings,
    config: MonteCarloConfig
): Promise<SimulationResult> {
    // Block bootstrap the data
    const blockSize = config.blockSize > 0 ? config.blockSize : 20;
    const bootstrappedData = blockBootstrap(data, blockSize, data.length);

    // Fix timestamps to be sequential
    const fixedData: OHLCVData[] = bootstrappedData.map((bar, idx) => ({
        ...bar,
        time: data[idx].time // Use original timestamps to maintain order
    }));

    // Apply latency shock by shifting signals
    const latencyShift = Math.floor(Math.random() * (config.latencyBars + 1));

    // Run backtest on bootstrapped data
    const signals = strategy.execute(fixedData, params);

    // Apply latency: shift signal times forward
    const delayedSignals = signals.map(s => {
        const idx = fixedData.findIndex(bar => bar.time === s.time);
        const newIdx = Math.min(idx + latencyShift, fixedData.length - 1);
        return {
            ...s,
            time: fixedData[newIdx]?.time ?? s.time
        };
    });

    // Apply slippage to signal prices
    const slippedSignals = delayedSignals.map(s => {
        const slippageAmount = s.price * (Math.random() * config.slippageBps / 10000);
        const slipDirection = s.type === 'buy' ? 1 : -1;
        return {
            ...s,
            price: s.price + slipDirection * slippageAmount
        };
    });

    const result = runBacktest(
        fixedData,
        slippedSignals,
        initialCapital,
        positionSizePercent,
        commissionPercent,
        backtestSettings
    );

    return {
        netProfit: result.netProfit,
        netProfitPercent: result.netProfitPercent,
        maxDrawdownPercent: result.maxDrawdownPercent,
        sharpeRatio: result.sharpeRatio,
        profitFactor: result.profitFactor,
        winRate: result.winRate,
        totalTrades: result.totalTrades
    };
}

// ============================================================================
// Advanced Metrics Calculation
// ============================================================================

function calculateProbabilisticSharpeRatio(
    observedSharpe: number,
    sharpeSamples: number[],
    numTrades: number
): number {
    if (numTrades < 2 || sharpeSamples.length < 2) return 0;

    // Standard error of Sharpe ratio estimation
    const sharpeStd = stdDev(sharpeSamples);
    if (sharpeStd <= 0) return observedSharpe > 0 ? 100 : 0;

    // Z-score for observed Sharpe
    const zScore = observedSharpe / sharpeStd;

    // Convert to probability using error function approximation
    const psr = 0.5 * (1 + erf(zScore / Math.sqrt(2)));
    return psr * 100;
}

function calculateDeflatedSharpeRatio(
    observedSharpe: number,
    numTrials: number,
    numTrades: number,
    expectedMaxSharpe: number = 0
): number {
    if (numTrades < 2 || numTrials < 1) return 0;

    // Expected maximum Sharpe under null hypothesis (random strategies)
    // Using approximation: E[max(S)] ≈ sqrt(2 * log(N)) where N = number of trials
    const eMaxSharpe = expectedMaxSharpe > 0
        ? expectedMaxSharpe
        : Math.sqrt(2 * Math.log(Math.max(1, numTrials)));

    // Deflate the observed Sharpe
    const deflatedSharpe = observedSharpe - eMaxSharpe * (1 / Math.sqrt(numTrades));

    return deflatedSharpe;
}

// Error function approximation
function erf(x: number): number {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x >= 0 ? 1 : -1;
    x = Math.abs(x);

    const t = 1 / (1 + p * x);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return sign * y;
}

function calculateRobustnessScore(result: MonteCarloResult): number {
    // Weighted scoring based on multiple factors
    let score = 0;

    // 1. Probability of profit (max 30 points)
    score += Math.min(30, result.probabilityOfProfit * 0.3);

    // 2. PSR score (max 25 points)
    score += Math.min(25, result.probabilisticSharpeRatio * 0.25);

    // 3. Tail risk (max 20 points) - lower max DD spread is better
    const ddSpread = result.maxDD95th - result.maxDD5th;
    const tailScore = Math.max(0, 20 - ddSpread * 0.4);
    score += tailScore;

    // 4. Consistency - narrow profit distribution (max 15 points)
    const profitRange = result.netProfit95th - result.netProfit5th;
    const profitRangePercent = result.originalResult.netProfit !== 0
        ? Math.abs(profitRange / result.originalResult.netProfit)
        : 1;
    const consistencyScore = Math.max(0, 15 - profitRangePercent * 10);
    score += consistencyScore;

    // 5. Positive median (max 10 points)
    if (result.netProfit50th > 0) {
        score += 10;
    } else if (result.netProfit50th > result.netProfit5th) {
        score += 5;
    }

    return Math.round(clamp(score, 0, 100));
}

function calculateFragilityIndex(result: MonteCarloResult): number {
    // Measures how sensitive the strategy is to noise (higher = more fragile)

    // 1. Variance in outcomes
    const profitCoV = result.netProfitMean !== 0
        ? Math.abs(result.netProfitStdDev / result.netProfitMean)
        : 1;

    // 2. Probability of significant loss (worse than -20% of original)
    const lossThreshold = result.originalResult.netProfit * -0.2;
    const significantLosses = result.simulations.filter(s => s.netProfit < lossThreshold).length;
    const lossRatio = significantLosses / result.totalSimulations;

    // 3. Drawdown tail risk
    const ddTailRisk = result.maxDD95th / 100;

    // Weighted fragility
    const fragility = (profitCoV * 30) + (lossRatio * 40) + (ddTailRisk * 30);

    return Math.round(clamp(fragility, 0, 100));
}

// ============================================================================
// Main Monte Carlo Analysis
// ============================================================================

export async function runMonteCarloAnalysis(
    data: OHLCVData[],
    strategy: Strategy,
    params: StrategyParams,
    originalResult: BacktestResult,
    initialCapital: number,
    positionSizePercent: number,
    commissionPercent: number,
    backtestSettings: BacktestSettings,
    config: Partial<MonteCarloConfig> = {}
): Promise<MonteCarloResult> {
    const startTime = performance.now();

    // Default config
    const fullConfig: MonteCarloConfig = {
        simulations: config.simulations ?? 500,
        blockSize: config.blockSize ?? 0,
        slippageBps: config.slippageBps ?? 5,
        spreadBps: config.spreadBps ?? 2,
        latencyBars: config.latencyBars ?? 0,
        confidenceLevel: config.confidenceLevel ?? 0.95,
        minTrades: config.minTrades ?? 5
    };

    // Clean data
    data = ensureCleanData(data);

    const simulations: SimulationResult[] = [];
    const trades = originalResult.trades;

    const BATCH_SIZE = 25;
    const useBlockBootstrap = fullConfig.blockSize > 0;

    for (let i = 0; i < fullConfig.simulations; i += BATCH_SIZE) {
        // Yield to event loop
        if (i > 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        const batchEnd = Math.min(i + BATCH_SIZE, fullConfig.simulations);

        for (let j = i; j < batchEnd; j++) {
            let sim: SimulationResult;

            if (useBlockBootstrap) {
                sim = await simulateBlockBootstrap(
                    data,
                    strategy,
                    params,
                    initialCapital,
                    positionSizePercent,
                    commissionPercent,
                    backtestSettings,
                    fullConfig
                );
            } else {
                sim = simulateTradeBootstrap(trades, initialCapital, fullConfig);
            }

            simulations.push(sim);
        }
    }

    // Calculate distributions
    const netProfits = simulations.map(s => s.netProfit);
    const maxDDs = simulations.map(s => s.maxDrawdownPercent);
    const sharpes = simulations.map(s => s.sharpeRatio);

    // Probability metrics
    const profitableCount = simulations.filter(s => s.netProfit > 0).length;
    const beatOriginalCount = simulations.filter(s => s.netProfit >= originalResult.netProfit).length;

    const result: MonteCarloResult = {
        simulations,
        totalSimulations: simulations.length,
        originalResult,

        // Probability metrics
        probabilityOfProfit: (profitableCount / simulations.length) * 100,
        probabilityBeatOriginal: (beatOriginalCount / simulations.length) * 100,

        // Net profit distribution
        netProfit5th: percentile(netProfits, 0.05),
        netProfit25th: percentile(netProfits, 0.25),
        netProfit50th: percentile(netProfits, 0.50),
        netProfit75th: percentile(netProfits, 0.75),
        netProfit95th: percentile(netProfits, 0.95),
        netProfitMean: mean(netProfits),
        netProfitStdDev: stdDev(netProfits),

        // Max DD distribution
        maxDD5th: percentile(maxDDs, 0.05),
        maxDD50th: percentile(maxDDs, 0.50),
        maxDD95th: percentile(maxDDs, 0.95),
        maxDDMean: mean(maxDDs),

        // Sharpe distribution
        sharpe5th: percentile(sharpes, 0.05),
        sharpe50th: percentile(sharpes, 0.50),
        sharpe95th: percentile(sharpes, 0.95),
        sharpeMean: mean(sharpes),

        // Advanced metrics (calculated later)
        probabilisticSharpeRatio: 0,
        deflatedSharpeRatio: 0,
        tailRatio: 0,

        robustnessScore: 0,
        fragilityIndex: 0,

        simulationTimeMs: 0
    };

    // Calculate advanced metrics
    result.probabilisticSharpeRatio = calculateProbabilisticSharpeRatio(
        originalResult.sharpeRatio,
        sharpes,
        originalResult.totalTrades
    );

    result.deflatedSharpeRatio = calculateDeflatedSharpeRatio(
        originalResult.sharpeRatio,
        fullConfig.simulations,
        originalResult.totalTrades
    );

    result.tailRatio = result.netProfit50th !== 0
        ? Math.abs(result.netProfit5th / result.netProfit50th)
        : 0;

    result.robustnessScore = calculateRobustnessScore(result);
    result.fragilityIndex = calculateFragilityIndex(result);

    result.simulationTimeMs = performance.now() - startTime;

    return result;
}

// ============================================================================
// Quick Monte Carlo (Auto-configured)
// ============================================================================

export async function quickMonteCarlo(
    data: OHLCVData[],
    strategy: Strategy,
    params: StrategyParams,
    originalResult: BacktestResult,
    initialCapital: number = 10000,
    positionSizePercent: number = 100,
    commissionPercent: number = 0.1
): Promise<MonteCarloResult> {
    return runMonteCarloAnalysis(
        data,
        strategy,
        params,
        originalResult,
        initialCapital,
        positionSizePercent,
        commissionPercent,
        {},
        {
            simulations: 250,
            blockSize: 0, // Trade-level bootstrap for speed
            slippageBps: 5,
            spreadBps: 2,
            latencyBars: 0,
            minTrades: 3
        }
    );
}

// ============================================================================
// Result Formatting
// ============================================================================

export function formatMonteCarloSummary(result: MonteCarloResult): string {
    const lines: string[] = [
        '═══════════════════════════════════════════════════════════════',
        '                    MONTE-CARLO ROBUSTNESS LAB                 ',
        '═══════════════════════════════════════════════════════════════',
        '',
        `Simulations Run:          ${result.totalSimulations}`,
        `Simulation Time:          ${(result.simulationTimeMs / 1000).toFixed(2)}s`,
        '',
        '─────────────────────────────────────────────────────────────────',
        '                       PROBABILITY METRICS                      ',
        '─────────────────────────────────────────────────────────────────',
        '',
        `Probability of Profit:    ${result.probabilityOfProfit.toFixed(1)}%`,
        `P(Beat Original):         ${result.probabilityBeatOriginal.toFixed(1)}%`,
        `Probabilistic Sharpe:     ${result.probabilisticSharpeRatio.toFixed(1)}%`,
        `Deflated Sharpe Ratio:    ${result.deflatedSharpeRatio.toFixed(3)}`,
        '',
        '─────────────────────────────────────────────────────────────────',
        '                      NET PROFIT DISTRIBUTION                   ',
        '─────────────────────────────────────────────────────────────────',
        '',
        `5th Percentile:           $${result.netProfit5th.toFixed(2)}`,
        `25th Percentile:          $${result.netProfit25th.toFixed(2)}`,
        `50th Percentile (Median): $${result.netProfit50th.toFixed(2)}`,
        `75th Percentile:          $${result.netProfit75th.toFixed(2)}`,
        `95th Percentile:          $${result.netProfit95th.toFixed(2)}`,
        '',
        `Mean:                     $${result.netProfitMean.toFixed(2)}`,
        `Std Dev:                  $${result.netProfitStdDev.toFixed(2)}`,
        '',
        '─────────────────────────────────────────────────────────────────',
        '                      MAX DRAWDOWN DISTRIBUTION                 ',
        '─────────────────────────────────────────────────────────────────',
        '',
        `5th Percentile:           ${result.maxDD5th.toFixed(1)}%`,
        `50th Percentile (Median): ${result.maxDD50th.toFixed(1)}%`,
        `95th Percentile:          ${result.maxDD95th.toFixed(1)}%`,
        '',
        '─────────────────────────────────────────────────────────────────',
        '                       ROBUSTNESS VERDICT                       ',
        '─────────────────────────────────────────────────────────────────',
        '',
        `Robustness Score:         ${result.robustnessScore}/100`,
        `Fragility Index:          ${result.fragilityIndex}/100`,
        '',
        getMonteCarloInterpretation(result.robustnessScore, result.fragilityIndex),
        '',
        '═══════════════════════════════════════════════════════════════'
    ];

    return lines.join('\n');
}

function getMonteCarloInterpretation(robustness: number, fragility: number): string {
    if (robustness >= 80 && fragility <= 20) {
        return '🟢 EXCELLENT: Strategy is highly robust. Low noise sensitivity. Safe for live trading.';
    }
    if (robustness >= 60 && fragility <= 40) {
        return '🟡 GOOD: Strategy shows reasonable robustness. Some noise sensitivity detected.';
    }
    if (robustness >= 40 && fragility <= 60) {
        return '🟠 MODERATE: Strategy has mixed robustness. Consider parameter constraints.';
    }
    if (robustness >= 20) {
        return '🔴 POOR: Strategy is fragile. High sensitivity to market noise. Review required.';
    }
    return '⛔ CRITICAL: Strategy is extremely fragile. Likely curve-fitted. Not recommended.';
}
