import type { BacktestResult, OHLCVData, Time, Trade } from '../../types/index';
import { toTimeKey } from '../../time-key';

// ============================================================================
// Types
// ============================================================================

/** Edge Ratio result for a single horizon */
export interface EdgeRatioHorizon {
    /** Number of bars after entry */
    bars: number;
    /** Average Maximum Favorable Excursion (% from entry, direction-adjusted) */
    avgMFE: number;
    /** Average Maximum Adverse Excursion (% from entry, direction-adjusted) */
    avgMAE: number;
    /** Edge Ratio = avgMFE / avgMAE. >1 = entry has predictive value */
    edgeRatio: number;
    /** Sample size for this horizon */
    sampleSize: number;
}

/** T-test result on trade returns */
export interface TTestResult {
    /** Mean trade return (%) */
    meanReturn: number;
    /** Standard deviation of returns */
    stdDev: number;
    /** T-statistic: how many standard errors the mean is from zero */
    tStatistic: number;
    /** Two-tailed p-value (probability result is due to chance) */
    pValue: number;
    /** Degrees of freedom (n - 1) */
    degreesOfFreedom: number;
    /** Sample size */
    sampleSize: number;
    /** Whether the result is statistically significant at α = 0.05 */
    isSignificant: boolean;
    /** Confidence level: 'very_high' (<0.01), 'high' (<0.05), 'moderate' (<0.10), 'low' (>=0.10) */
    confidence: 'very_high' | 'high' | 'moderate' | 'low';
}

/** Win/loss streak analysis */
export interface StreakAnalysis {
    /** Maximum consecutive wins observed */
    maxWinStreak: number;
    /** Maximum consecutive losses observed */
    maxLossStreak: number;
    /** Average win streak length */
    avgWinStreak: number;
    /** Average loss streak length */
    avgLossStreak: number;
    /** Expected max win streak under random coin-flip model with same win rate */
    expectedMaxWinStreak: number;
    /** Expected max loss streak under random coin-flip model */
    expectedMaxLossStreak: number;
    /** Z-score: how unusual the win streaks are compared to random */
    winStreakZScore: number;
    /** Z-score: how unusual the loss streaks are compared to random */
    lossStreakZScore: number;
    /** Whether any clustering is statistically unusual (z > 2 on either side) */
    hasRegimeClustering: boolean;
    /** Whether win streaks are unusually long (z > 2) */
    hasWinRegimeClustering: boolean;
    /** Whether loss streaks are unusually long (z > 2) */
    hasLossRegimeClustering: boolean;
    /** All win streak lengths for distribution analysis */
    winStreakDistribution: number[];
    /** All loss streak lengths for distribution analysis */
    lossStreakDistribution: number[];
    /** Total number of trades analyzed */
    sampleSize: number;
}

/** Combined edge statistics */
export interface EdgeStatistics {
    /** Edge ratio at multiple horizons (exit-independent entry quality proof) */
    edgeRatios: EdgeRatioHorizon[];
    /** Composite edge ratio (average across horizons) */
    compositeEdgeRatio: number;
    /** T-test on trade returns (statistical significance) */
    tTest: TTestResult;
    /** Streak analysis (regime detection) */
    streaks: StreakAnalysis;
    /** Overall edge verdict: 'strong', 'moderate', 'weak', 'none' */
    verdict: 'strong' | 'moderate' | 'weak' | 'none';
    /** Human-readable summary of the edge analysis */
    summary: string;
}

// ============================================================================
// Edge Ratio Computation
// ============================================================================

/** Horizons to evaluate (bars after entry) */
const EDGE_RATIO_HORIZONS = [3, 5, 8, 12];

/**
 * Compute the Edge Ratio at multiple horizons.
 *
 * For each trade, we look at N bars after entry and compute:
 * - MFE: Maximum price move IN the trade direction (favorable)
 * - MAE: Maximum price move AGAINST the trade direction (adverse)
 *
 * Edge Ratio = avgMFE / avgMAE
 * > 1.0 = entries have genuine predictive value (price tends to move in your favor)
 * = 1.0 = random entries
 * < 1.0 = entries are counter-productive
 */
export function computeEdgeRatios(
    trades: Trade[],
    ohlcvData: OHLCVData[],
    horizons: number[] = EDGE_RATIO_HORIZONS
): EdgeRatioHorizon[] {
    if (trades.length === 0 || ohlcvData.length === 0) return [];

    // Build time → index map
    const timeIndex = new Map<string, number>();
    for (let i = 0; i < ohlcvData.length; i++) {
        timeIndex.set(timeKey(ohlcvData[i].time), i);
    }

    const results: EdgeRatioHorizon[] = [];

    for (const horizonBars of horizons) {
        let mfeSum = 0;
        let maeSum = 0;
        let count = 0;

        for (const trade of trades) {
            // Skip incomplete trades
            if (trade.exitReason === 'end_of_data') continue;

            const entryIdx = timeIndex.get(timeKey(trade.entryTime));
            if (entryIdx === undefined) continue;
            if (!Number.isFinite(trade.entryPrice) || trade.entryPrice <= 0) continue;

            const endIdx = entryIdx + horizonBars;
            // Only evaluate trades that have the full horizon available.
            if (endIdx >= ohlcvData.length) continue;

            const isLong = trade.type === 'long';
            let mfe = 0; // best favorable excursion
            let mae = 0; // worst adverse excursion

            for (let i = entryIdx + 1; i <= endIdx; i++) {
                const bar = ohlcvData[i];
                if (!Number.isFinite(bar.high) || !Number.isFinite(bar.low)) continue;

                // Favorable: high for long, low for short
                // Adverse: low for long, high for short
                const favorablePrice = isLong ? bar.high : bar.low;
                const adversePrice = isLong ? bar.low : bar.high;

                const favorableMove = isLong
                    ? (favorablePrice - trade.entryPrice) / trade.entryPrice * 100
                    : (trade.entryPrice - favorablePrice) / trade.entryPrice * 100;

                const adverseMove = isLong
                    ? (trade.entryPrice - adversePrice) / trade.entryPrice * 100
                    : (adversePrice - trade.entryPrice) / trade.entryPrice * 100;

                if (favorableMove > mfe) mfe = favorableMove;
                if (adverseMove > mae) mae = adverseMove;
            }

            mfeSum += mfe;
            maeSum += mae;
            count++;
        }

        if (count > 0) {
            const avgMFE = mfeSum / count;
            const avgMAE = maeSum / count;
            const edgeRatio = avgMAE > 0.0001 ? avgMFE / avgMAE : (avgMFE > 0 ? 999 : 1);

            results.push({
                bars: horizonBars,
                avgMFE: round4(avgMFE),
                avgMAE: round4(avgMAE),
                edgeRatio: round4(edgeRatio),
                sampleSize: count,
            });
        }
    }

    return results;
}

// ============================================================================
// T-Test on Trade Returns
// ============================================================================

/**
 * One-sample T-test: tests whether mean trade return differs from zero.
 * 
 * H₀: μ = 0 (strategy has no edge, returns are random)
 * H₁: μ ≠ 0 (strategy has a non-zero expected return)
 * 
 * If p < 0.05, we reject H₀ and conclude the strategy has a 
 * statistically significant edge with 95% confidence.
 */
export function computeTTest(trades: Trade[]): TTestResult {
    const returns = trades
        .filter(t => t.exitReason !== 'end_of_data')
        .map(t => t.pnlPercent);

    const n = returns.length;

    if (n < 3) {
        return {
            meanReturn: 0,
            stdDev: 0,
            tStatistic: 0,
            pValue: 1,
            degreesOfFreedom: 0,
            sampleSize: n,
            isSignificant: false,
            confidence: 'low',
        };
    }

    const mean = returns.reduce((s, v) => s + v, 0) / n;
    const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1); // Bessel's correction
    const stdDev = Math.sqrt(variance);
    const standardError = stdDev / Math.sqrt(n);
    const hasZeroVariance = standardError <= 1e-12;
    const tStatistic = hasZeroVariance
        ? (mean > 0 ? Number.POSITIVE_INFINITY : mean < 0 ? Number.NEGATIVE_INFINITY : 0)
        : mean / standardError;
    const df = n - 1;

    // Approximate two-tailed p-value using Student's t-distribution
    const pValue = hasZeroVariance
        ? (mean === 0 ? 1 : 0)
        : tDistributionPValue(Math.abs(tStatistic), df);

    let confidence: TTestResult['confidence'];
    if (pValue < 0.01) confidence = 'very_high';
    else if (pValue < 0.05) confidence = 'high';
    else if (pValue < 0.10) confidence = 'moderate';
    else confidence = 'low';

    return {
        meanReturn: round4(mean),
        stdDev: round4(stdDev),
        tStatistic: round4(tStatistic),
        pValue: round6(pValue),
        degreesOfFreedom: df,
        sampleSize: n,
        isSignificant: pValue < 0.05,
        confidence,
    };
}

// ============================================================================
// Win/Loss Streak Analysis
// ============================================================================

/**
 * Analyze win/loss streak patterns and compare to random expectations.
 * 
 * Under a random model (Bernoulli trials with observed win rate p):
 * - Expected max run length ≈ log(n) / log(1/p)
 * - If actual streaks significantly exceed expected, the strategy
 *   is capturing genuine market regimes (not just random)
 */
export function computeStreakAnalysis(trades: Trade[]): StreakAnalysis {
    const filtered = trades.filter(t => t.exitReason !== 'end_of_data');
    const n = filtered.length;

    if (n < 3) {
        return emptyStreakAnalysis(n);
    }

    const outcomes: boolean[] = filtered.map(t => t.pnl > 0); // true = win

    // Extract all streak lengths
    const winStreaks: number[] = [];
    const lossStreaks: number[] = [];
    let currentStreak = 1;

    for (let i = 1; i < outcomes.length; i++) {
        if (outcomes[i] === outcomes[i - 1]) {
            currentStreak++;
        } else {
            if (outcomes[i - 1]) {
                winStreaks.push(currentStreak);
            } else {
                lossStreaks.push(currentStreak);
            }
            currentStreak = 1;
        }
    }
    // Push final streak
    if (outcomes[outcomes.length - 1]) {
        winStreaks.push(currentStreak);
    } else {
        lossStreaks.push(currentStreak);
    }

    const maxWinStreak = winStreaks.length > 0 ? Math.max(...winStreaks) : 0;
    const maxLossStreak = lossStreaks.length > 0 ? Math.max(...lossStreaks) : 0;
    const avgWinStreak = winStreaks.length > 0 ? winStreaks.reduce((s, v) => s + v, 0) / winStreaks.length : 0;
    const avgLossStreak = lossStreaks.length > 0 ? lossStreaks.reduce((s, v) => s + v, 0) / lossStreaks.length : 0;

    // Random expectations under Bernoulli model
    const winRate = outcomes.filter(Boolean).length / n;
    const lossRate = 1 - winRate;

    const expectedMaxWinStreak = expectedMaxRun(n, winRate);
    const expectedMaxLossStreak = expectedMaxRun(n, lossRate);

    // Z-scores for max streak deviation from expected
    // StdDev of max run ≈ π / (√6 * log(1/p))
    const winStreakStd = maxRunStdDev(winRate);
    const lossStreakStd = maxRunStdDev(lossRate);

    const winStreakZScore = winStreakStd > 0 ? (maxWinStreak - expectedMaxWinStreak) / winStreakStd : 0;
    const lossStreakZScore = lossStreakStd > 0 ? (maxLossStreak - expectedMaxLossStreak) / lossStreakStd : 0;

    // Regime clustering if either Z > 2 (streaks are unusually long)
    const hasWinRegimeClustering = winStreakZScore > 2;
    const hasLossRegimeClustering = lossStreakZScore > 2;
    const hasRegimeClustering = hasWinRegimeClustering || hasLossRegimeClustering;

    return {
        maxWinStreak,
        maxLossStreak,
        avgWinStreak: round4(avgWinStreak),
        avgLossStreak: round4(avgLossStreak),
        expectedMaxWinStreak: round4(expectedMaxWinStreak),
        expectedMaxLossStreak: round4(expectedMaxLossStreak),
        winStreakZScore: round4(winStreakZScore),
        lossStreakZScore: round4(lossStreakZScore),
        hasRegimeClustering,
        hasWinRegimeClustering,
        hasLossRegimeClustering,
        winStreakDistribution: winStreaks,
        lossStreakDistribution: lossStreaks,
        sampleSize: n,
    };
}

// ============================================================================
// Combined Edge Analysis
// ============================================================================

/**
 * Compute all Tier 1 edge indicators and produce an overall verdict.
 */
export function computeEdgeStatistics(
    result: BacktestResult,
    ohlcvData: OHLCVData[]
): EdgeStatistics {
    const trades = result.trades;

    const edgeRatios = computeEdgeRatios(trades, ohlcvData);
    const tTest = computeTTest(trades);
    const streaks = computeStreakAnalysis(trades);

    // Composite edge ratio: average of all horizons
    const compositeEdgeRatio = edgeRatios.length > 0
        ? round4(edgeRatios.reduce((s, r) => s + r.edgeRatio, 0) / edgeRatios.length)
        : 1;

    // Overall verdict scoring
    let score = 0;
    const reasons: string[] = [];

    // Edge Ratio scoring (0-3 points)
    if (compositeEdgeRatio >= 1.5) {
        score += 3;
        reasons.push(`Strong entry edge (ER: ${compositeEdgeRatio.toFixed(2)})`);
    } else if (compositeEdgeRatio >= 1.2) {
        score += 2;
        reasons.push(`Moderate entry edge (ER: ${compositeEdgeRatio.toFixed(2)})`);
    } else if (compositeEdgeRatio >= 1.0) {
        score += 1;
        reasons.push(`Marginal entry edge (ER: ${compositeEdgeRatio.toFixed(2)})`);
    } else {
        reasons.push(`No entry edge (ER: ${compositeEdgeRatio.toFixed(2)} < 1.0)`);
    }

    // T-test scoring (0-3 points)
    if (tTest.confidence === 'very_high' && tTest.meanReturn > 0) {
        score += 3;
        reasons.push(`Returns highly significant (p=${tTest.pValue.toFixed(4)})`);
    } else if (tTest.confidence === 'high' && tTest.meanReturn > 0) {
        score += 2;
        reasons.push(`Returns significant (p=${tTest.pValue.toFixed(4)})`);
    } else if (tTest.confidence === 'moderate' && tTest.meanReturn > 0) {
        score += 1;
        reasons.push(`Returns marginally significant (p=${tTest.pValue.toFixed(4)})`);
    } else if (tTest.meanReturn <= 0) {
        reasons.push(`Negative mean return (${tTest.meanReturn.toFixed(4)}%)`);
    } else {
        reasons.push(`Returns not significant (p=${tTest.pValue.toFixed(4)})`);
    }

    // Streak scoring (0-2 points)
    if (streaks.hasWinRegimeClustering) {
        score += 2;
        reasons.push('Win clustering detected (captures regimes)');
    } else if (streaks.hasLossRegimeClustering) {
        reasons.push('Loss clustering detected (adverse regimes)');
    } else if (streaks.avgWinStreak > streaks.avgLossStreak * 1.2) {
        score += 1;
        reasons.push('Wins tend to cluster');
    } else {
        reasons.push('No unusual streak patterns');
    }

    // Verdict
    let verdict: EdgeStatistics['verdict'];
    if (score >= 6) verdict = 'strong';
    else if (score >= 4) verdict = 'moderate';
    else if (score >= 2) verdict = 'weak';
    else verdict = 'none';

    const summary = reasons.join(' • ');

    return {
        edgeRatios,
        compositeEdgeRatio,
        tTest,
        streaks,
        verdict,
        summary,
    };
}

// ============================================================================
// Math Helpers
// ============================================================================

function timeKey(time: Time): string {
    return toTimeKey(time);
}

function round4(v: number): number {
    return Math.round(v * 10000) / 10000;
}

function round6(v: number): number {
    return Math.round(v * 1000000) / 1000000;
}

/**
 * Approximate p-value for two-tailed t-test using the
 * regularized incomplete beta function approximation.
 * 
 * For large df, Student's t approaches the normal distribution.
 * We use a refined approximation that works well for df >= 1.
 */
function tDistributionPValue(t: number, df: number): number {
    if (df <= 0 || !Number.isFinite(t)) return 1;

    // Use the relationship: p = I(df/(df+t²), df/2, 1/2) 
    // where I is the regularized incomplete beta function
    const x = df / (df + t * t);
    const a = df / 2;
    const b = 0.5;

    // Approximate using the continued fraction / series expansion
    const betaInc = regularizedIncompleteBeta(x, a, b);
    return Math.max(0, Math.min(1, betaInc));
}

/**
 * Regularized incomplete beta function I_x(a, b) approximation.
 * Uses the series expansion for numerical stability.
 */
function regularizedIncompleteBeta(x: number, a: number, b: number): number {
    if (x <= 0) return 0;
    if (x >= 1) return 1;

    // For better convergence, use the identity:
    // I_x(a,b) = 1 - I_{1-x}(b,a) when x > (a+1)/(a+b+2)
    if (x > (a + 1) / (a + b + 2)) {
        return 1 - regularizedIncompleteBeta(1 - x, b, a);
    }

    // Prefix: x^a * (1-x)^b / (a * B(a,b))
    const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
    const prefix = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lnBeta) / a;

    // Lentz's continued fraction method — numerically stable and well-converged
    return prefix * betaContinuedFraction(x, a, b);
}

/**
 * Evaluate the continued fraction for the incomplete beta function
 * using the modified Lentz method.
 */
function betaContinuedFraction(x: number, a: number, b: number): number {
    const TINY = 1e-30;
    const EPS = 1e-10;
    const MAX_ITER = 200;

    let f = 1;
    let C = 1;
    let D = 1 - (a + b) * x / (a + 1);
    if (Math.abs(D) < TINY) D = TINY;
    D = 1 / D;
    f = D;

    for (let m = 1; m <= MAX_ITER; m++) {
        // Even step: d_{2m}
        let numerator = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
        D = 1 + numerator * D;
        if (Math.abs(D) < TINY) D = TINY;
        C = 1 + numerator / C;
        if (Math.abs(C) < TINY) C = TINY;
        D = 1 / D;
        f *= C * D;

        // Odd step: d_{2m+1}
        numerator = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
        D = 1 + numerator * D;
        if (Math.abs(D) < TINY) D = TINY;
        C = 1 + numerator / C;
        if (Math.abs(C) < TINY) C = TINY;
        D = 1 / D;

        const delta = C * D;
        f *= delta;

        if (Math.abs(delta - 1) < EPS) break;
    }

    return f;
}

/**
 * Log-gamma function approximation (Stirling series).
 */
function lnGamma(z: number): number {
    if (z <= 0) return 0;

    // Lanczos approximation coefficients (g=7, n=9)
    const g = 7;
    const c = [
        0.99999999999980993,
        676.5203681218851,
        -1259.1392167224028,
        771.32342877765313,
        -176.61502916214059,
        12.507343278686905,
        -0.13857109526572012,
        9.9843695780195716e-6,
        1.5056327351493116e-7,
    ];

    if (z < 0.5) {
        return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
    }

    z -= 1;
    let x = c[0];
    for (let i = 1; i < g + 2; i++) {
        x += c[i] / (z + i);
    }

    const t = z + g + 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * Expected maximum run length for n Bernoulli trials with success probability p.
 * Formula: E[max run] ≈ log(n) / log(1/p) + γ/(log(1/p)) - 0.5
 * where γ is the Euler–Mascheroni constant ≈ 0.5772
 */
function expectedMaxRun(n: number, p: number): number {
    if (n <= 0 || p <= 0 || p >= 1) return 0;
    const logInvP = Math.log(1 / p);
    if (logInvP <= 0) return 0;
    const euler = 0.5772156649;
    return Math.log(n) / logInvP + euler / logInvP - 0.5;
}

/**
 * Approximate standard deviation of the maximum run length.
 * StdDev ≈ π / (√6 × log(1/p))
 */
function maxRunStdDev(p: number): number {
    if (p <= 0 || p >= 1) return 0;
    const logInvP = Math.log(1 / p);
    if (logInvP <= 0) return 0;
    return Math.PI / (Math.sqrt(6) * logInvP);
}

function emptyStreakAnalysis(sampleSize: number): StreakAnalysis {
    return {
        maxWinStreak: 0,
        maxLossStreak: 0,
        avgWinStreak: 0,
        avgLossStreak: 0,
        expectedMaxWinStreak: 0,
        expectedMaxLossStreak: 0,
        winStreakZScore: 0,
        lossStreakZScore: 0,
        hasRegimeClustering: false,
        hasWinRegimeClustering: false,
        hasLossRegimeClustering: false,
        winStreakDistribution: [],
        lossStreakDistribution: [],
        sampleSize,
    };
}
