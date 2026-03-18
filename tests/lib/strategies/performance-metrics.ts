const SHARPE_MIN_TRADES = 5;
const SHARPE_MIN_STD_DEV = 1e-4;
const SHARPE_MAX_ABS = 8;

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/**
 * Normalizes Sharpe to avoid unstable values caused by near-zero variance,
 * very small sample sizes, or numeric noise.
 */
export function calculateSharpeRatioFromMoments(
    avgReturn: number,
    stdReturn: number,
    tradeCount: number
): number {
    if (!Number.isFinite(avgReturn) || !Number.isFinite(stdReturn)) return 0;
    if (tradeCount < SHARPE_MIN_TRADES) return 0;
    if (stdReturn < SHARPE_MIN_STD_DEV) return 0;

    const raw = avgReturn / stdReturn;
    if (!Number.isFinite(raw)) return 0;

    return clamp(raw, -SHARPE_MAX_ABS, SHARPE_MAX_ABS);
}

export function calculateSharpeRatioFromReturns(returns: number[]): number {
    const finiteReturns = returns.filter(value => Number.isFinite(value));
    if (finiteReturns.length < SHARPE_MIN_TRADES) return 0;

    const avgReturn = finiteReturns.reduce((sum, value) => sum + value, 0) / finiteReturns.length;
    const variance = finiteReturns.length > 1
        ? finiteReturns.reduce((sum, value) => sum + Math.pow(value - avgReturn, 2), 0) / (finiteReturns.length - 1)
        : 0;
    const stdReturn = Math.sqrt(Math.max(0, variance));

    return calculateSharpeRatioFromMoments(avgReturn, stdReturn, finiteReturns.length);
}

export function sanitizeSharpeRatio(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return clamp(value, -SHARPE_MAX_ABS, SHARPE_MAX_ABS);
}
