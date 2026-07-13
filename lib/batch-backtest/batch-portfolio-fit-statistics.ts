/**
 * Portfolio Fit Mining — pure statistics: directional returns, time alignment,
 * covariance, expected shortfall / CVaR, marginal contributions, shrinkage.
 *
 * Pure leaf module. Imports only `OHLCVData` type-only + the server-safe
 * `percentile` helper from `lib/strategies/sizing/shared.ts` (which itself
 * imports only a type and `parseTimeToUnixSeconds`). No browser-bound imports.
 *
 * Phase 0 resolutions:
 *  - R3: close-to-close returns keyed by `timeKey`.
 *  - R7: min 30 aligned observations for covariance.
 *  - R13: singular covariance → bounded diagonal shrinkage → fail closed.
 *  - Long = +r, short = -r before covariance/downside.
 *
 * Why local (not re-exported from portfolio-lab-statistics):
 * `portfolio-lab-statistics.ts` exports `computeCorrelation` (pairwise) but no
 * covariance, no N×N matrix, no expected shortfall. Re-implementing here keeps
 * the server graph clean and gives us full control over the directional sign
 * convention and shrinkage.
 */

import { percentile } from "../strategies/sizing/shared";

// ---------------------------------------------------------------------------
// Directional returns
// ---------------------------------------------------------------------------

/**
 * Applies the direction sign to a raw close-to-close return. Long preserves
 * the sign; short negates it. This is the single place the convention is
 * encoded so covariance/downside/marginal risk all see consistent signs.
 */
export function applyDirection(rawReturn: number, direction: "long" | "short"): number {
    return direction === "long" ? rawReturn : -rawReturn;
}

/**
 * Builds a direction-adjusted return series keyed by `timeKey`. The input map
 * is raw close-to-close returns (positive = price rose). Output values carry
 * the direction sign so a short candidate's positive-edge returns are negative
 * raw returns (price fell → short profited).
 */
export function buildDirectionalReturnSeries(
    rawReturns: ReadonlyMap<string, number>,
    direction: "long" | "short",
): Map<string, number> {
    const out = new Map<string, number>();
    for (const [key, value] of rawReturns) {
        if (Number.isFinite(value)) {
            out.set(key, applyDirection(value, direction));
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Time alignment — intersect keys, preserve order
// ---------------------------------------------------------------------------

/**
 * Returns the sorted intersection of all key sets, as a string[] in ascending
 * timeKey order. Used as the common observation axis for covariance.
 */
export function intersectTimeKeys(
    series: ReadonlyArray<ReadonlyMap<string, number>>,
): string[] {
    if (series.length === 0) return [];
    let keys: Set<string> | null = null;
    for (const m of series) {
        if (keys === null) {
            keys = new Set(m.keys());
        } else {
            const next = new Set<string>();
            for (const k of keys) {
                if (m.has(k)) next.add(k);
            }
            keys = next;
        }
    }
    const out = keys ? Array.from(keys) : [];
    out.sort();
    return out;
}

/**
 * Extracts a dense `number[]` (NaN-free) for one series over the given keys.
 * Keys without a finite value are skipped for BOTH series in pairwise ops;
 * this helper just extracts the raw values, and pairwise alignment drops NaN.
 */
export function extractAlignedValues(
    series: ReadonlyMap<string, number>,
    keys: readonly string[],
): number[] {
    const out: number[] = [];
    for (const k of keys) {
        const v = series.get(k);
        if (v !== undefined && Number.isFinite(v)) out.push(v);
    }
    return out;
}

/**
 * Pairwise-aligned values: returns two equal-length `number[]` arrays
 * containing only the keys present and finite in BOTH series. This is the
 * minimum-overlap seam (mirrors `computeCorrelation`'s ≥3 overlap rule but
 * we raise the floor via `minObservations` at the caller).
 */
export function alignPairwise(
    a: ReadonlyMap<string, number>,
    b: ReadonlyMap<string, number>,
): { xs: number[]; ys: number[] } {
    const xs: number[] = [];
    const ys: number[] = [];
    // Iterate the smaller map for efficiency.
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const [k, v] of small) {
        if (!Number.isFinite(v)) continue;
        const w = large.get(k);
        if (w !== undefined && Number.isFinite(w)) {
            // Preserve (a, b) ordering regardless of which was smaller.
            if (small === a) {
                xs.push(v);
                ys.push(w);
            } else {
                xs.push(w);
                ys.push(v);
            }
        }
    }
    return { xs, ys };
}

// ---------------------------------------------------------------------------
// Mean, variance, covariance, correlation
// ---------------------------------------------------------------------------

export function mean(values: readonly number[]): number {
    if (values.length === 0) return 0;
    let sum = 0;
    for (const v of values) sum += v;
    return sum / values.length;
}

export function sampleVariance(values: readonly number[]): number {
    const n = values.length;
    if (n < 2) return 0;
    const m = mean(values);
    let acc = 0;
    for (const v of values) {
        const d = v - m;
        acc += d * d;
    }
    return acc / (n - 1);
}

export function sampleStandardDeviation(values: readonly number[]): number {
    return Math.sqrt(sampleVariance(values));
}

/**
 * Sample covariance over pairwise-finite observations. Returns 0 when fewer
 * than 2 overlapping observations exist (caller must gate on `minObservations`
 * before trusting the result).
 */
export function sampleCovariance(
    a: ReadonlyMap<string, number>,
    b: ReadonlyMap<string, number>,
): { covariance: number; overlap: number } {
    const { xs, ys } = alignPairwise(a, b);
    const n = xs.length;
    if (n < 2) return { covariance: 0, overlap: n };
    const mx = mean(xs);
    const my = mean(ys);
    let acc = 0;
    for (let i = 0; i < n; i++) {
        acc += (xs[i] - mx) * (ys[i] - my);
    }
    return { covariance: acc / (n - 1), overlap: n };
}

/**
 * Pearson correlation over pairwise-finite observations. Mirrors
 * `computeCorrelation` from `portfolio-lab-statistics.ts` but lives here so
 * the engine does not depend on the portfolio-lab barrel.
 */
export function pearsonCorrelation(
    a: ReadonlyMap<string, number>,
    b: ReadonlyMap<string, number>,
): { correlation: number | null; overlap: number } {
    const { xs, ys } = alignPairwise(a, b);
    const n = xs.length;
    if (n < 3) return { correlation: null, overlap: n };
    const mx = mean(xs);
    const my = mean(ys);
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < n; i++) {
        const ox = xs[i] - mx;
        const oy = ys[i] - my;
        num += ox * oy;
        dx += ox * ox;
        dy += oy * oy;
    }
    if (dx <= 0 || dy <= 0) return { correlation: null, overlap: n };
    const r = num / Math.sqrt(dx * dy);
    // Guard against tiny floating-point excursions outside [-1, 1].
    return { correlation: Math.max(-1, Math.min(1, r)), overlap: n };
}

// ---------------------------------------------------------------------------
// N×N covariance matrix with diagonal shrinkage (R13)
// ---------------------------------------------------------------------------

export interface CovarianceMatrix {
    /** n×n matrix; matrix[i][j] = covariance(series[i], series[j]). */
    matrix: number[][];
    /** Diagonal entries = sample variances. */
    variances: number[];
    /** Pairwise overlap counts; overlaps[i][j] = observations used. */
    overlaps: number[][];
    /** Minimum pairwise overlap across the upper triangle. */
    minOverlap: number;
    /** True if shrinkage was applied. */
    shrunk: boolean;
    /** True if the matrix is finite and usable. */
    valid: boolean;
}

/**
 * Builds an n×n covariance matrix from directional return series. If any
 * diagonal variance is non-finite or the matrix is singular, applies bounded
 * diagonal shrinkage (factor 0.1 toward the mean variance). If still invalid
 * after shrinkage, returns `valid: false` so the caller can fail closed (R13).
 *
 * @param series Direction-adjusted return series (one per candidate).
 * @param minObservations Minimum pairwise overlap required; below this the
 *   matrix is marked invalid.
 */
export function buildCovarianceMatrix(
    series: ReadonlyArray<ReadonlyMap<string, number>>,
    minObservations: number,
): CovarianceMatrix {
    const n = series.length;
    const matrix: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    const variances: number[] = new Array<number>(n).fill(0);
    const overlaps: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    let minOverlap = Number.POSITIVE_INFINITY;
    let allFinite = true;

    for (let i = 0; i < n; i++) {
        const { covariance: covII, overlap: ovII } = sampleCovariance(series[i], series[i]);
        matrix[i][i] = covII;
        variances[i] = covII;
        overlaps[i][i] = ovII;
        if (ovII < minOverlap) minOverlap = ovII;
        if (!Number.isFinite(covII)) allFinite = false;
        for (let j = i + 1; j < n; j++) {
            const { covariance: covIJ, overlap: ovIJ } = sampleCovariance(series[i], series[j]);
            matrix[i][j] = covIJ;
            matrix[j][i] = covIJ;
            overlaps[i][j] = ovIJ;
            overlaps[j][i] = ovIJ;
            if (ovIJ < minOverlap) minOverlap = ovIJ;
            if (!Number.isFinite(covIJ)) allFinite = false;
        }
    }

    if (n === 0) {
        return { matrix, variances, overlaps, minOverlap: 0, shrunk: false, valid: false };
    }
    if (!Number.isFinite(minOverlap) || minOverlap < minObservations || !allFinite) {
        // Try diagonal shrinkage before giving up.
        const shrunkResult = applyDiagonalShrinkage(matrix, variances, n);
        return {
            matrix: shrunkResult.matrix,
            variances,
            overlaps,
            minOverlap,
            shrunk: true,
            valid: shrunkResult.valid && Number.isFinite(minOverlap) && minOverlap >= minObservations,
        };
    }
    return { matrix, variances, overlaps, minOverlap, shrunk: false, valid: true };
}

function applyDiagonalShrinkage(
    matrix: number[][],
    variances: number[],
    n: number,
): { matrix: number[][]; valid: boolean } {
    // Replace non-finite variances with the mean of finite variances.
    const finiteVariances = variances.filter((v) => Number.isFinite(v) && v > 0);
    const meanVariance =
        finiteVariances.length > 0
            ? finiteVariances.reduce((s, v) => s + v, 0) / finiteVariances.length
            : 1e-6;
    const fallback = meanVariance > 0 ? meanVariance : 1e-6;
    let valid = true;
    for (let i = 0; i < n; i++) {
        if (!Number.isFinite(matrix[i][i]) || matrix[i][i] <= 0) {
            matrix[i][i] = fallback;
            valid = valid && Number.isFinite(matrix[i][i]);
        }
        for (let j = i + 1; j < n; j++) {
            if (!Number.isFinite(matrix[i][j])) {
                matrix[i][j] = 0;
                matrix[j][i] = 0;
            }
            // Bounded shrinkage: pull off-diagonal toward 0 by factor 0.1.
            matrix[i][j] = matrix[i][j] * (1 - 0.1);
            matrix[j][i] = matrix[i][j];
        }
    }
    return { matrix, valid };
}

// ---------------------------------------------------------------------------
// Expected shortfall / CVaR (R13)
// ---------------------------------------------------------------------------

/**
 * Historical expected shortfall (average of the worst `tailFraction` of
 * returns). Returns a non-positive number for a long-only portfolio (losses
 * are negative returns). Mirrors the private `calculateExpectedShortfall` in
 * `risk-parity.ts` but uses the exported `percentile` helper.
 *
 * @param returns Portfolio return observations (signed).
 * @param tailFraction Fraction in (0, 1), e.g. 0.05 for the 5th percentile tail.
 * @returns The mean of the worst `ceil(n * tailFraction)` returns, or 0 if
 *   the input is empty. Always finite.
 */
export function historicalExpectedShortfall(
    returns: readonly number[],
    tailFraction: number,
): number {
    const n = returns.length;
    if (n === 0) return 0;
    const finite = returns.filter((r) => Number.isFinite(r));
    if (finite.length === 0) return 0;
    const tailCount = Math.max(1, Math.ceil(finite.length * tailFraction));
    const sorted = [...finite].sort((a, b) => a - b);
    let sum = 0;
    for (let i = 0; i < tailCount; i++) {
        sum += sorted[i];
    }
    return sum / tailCount;
}

/**
 * Value at risk at the given tail fraction (the percentile threshold itself,
 * not the mean). Useful for diagnostics.
 */
export function historicalValueAtRisk(
    returns: readonly number[],
    tailFraction: number,
): number {
    const finite = returns.filter((r) => Number.isFinite(r));
    if (finite.length === 0) return 0;
    return percentile(finite, tailFraction);
}

// ---------------------------------------------------------------------------
// Portfolio risk from weights + covariance
// ---------------------------------------------------------------------------

/**
 * Portfolio variance = wᵀ Σ w. Returns 0 for an empty portfolio.
 */
export function portfolioVariance(
    weights: readonly number[],
    covariance: ReadonlyArray<ReadonlyArray<number>>,
): number {
    const n = weights.length;
    if (n === 0) return 0;
    let acc = 0;
    for (let i = 0; i < n; i++) {
        const wi = weights[i];
        if (!Number.isFinite(wi)) continue;
        for (let j = 0; j < n; j++) {
            const wj = weights[j];
            if (!Number.isFinite(wj)) continue;
            acc += wi * wj * (covariance[i]?.[j] ?? 0);
        }
    }
    return Number.isFinite(acc) ? acc : 0;
}

export function portfolioVolatility(
    weights: readonly number[],
    covariance: ReadonlyArray<ReadonlyArray<number>>,
): number {
    const v = portfolioVariance(weights, covariance);
    const sq = Math.sqrt(v);
    return Number.isFinite(sq) ? sq : 0;
}

// ---------------------------------------------------------------------------
// Marginal contributions (R13)
// ---------------------------------------------------------------------------

/**
 * Marginal volatility contribution of candidate `i`: the change in portfolio
 * volatility from adding a small delta to weight `i`. Approximated as
 * (Σ w)_i / sqrt(wᵀ Σ w) when portfolio volatility is non-zero.
 */
export function marginalVolatilityContribution(
    weights: readonly number[],
    covariance: ReadonlyArray<ReadonlyArray<number>>,
    index: number,
): number {
    const n = weights.length;
    if (n === 0) return 0;
    const pv = portfolioVolatility(weights, covariance);
    if (pv <= 0) return 0;
    let rowSum = 0;
    for (let j = 0; j < n; j++) {
        const wj = weights[j];
        if (!Number.isFinite(wj)) continue;
        rowSum += (covariance[index]?.[j] ?? 0) * wj;
    }
    return Number.isFinite(rowSum) ? rowSum / pv : 0;
}

/**
 * Marginal expected shortfall: the change in portfolio ES from including
 * candidate `i`'s returns at weight `delta`. Computed by recomputing ES with
 * and without the candidate's contribution to each portfolio observation.
 *
 * @param portfolioReturns Existing portfolio return observations keyed by time.
 * @param candidateReturns Candidate's direction-adjusted returns.
 * @param candidateWeight The weight being added (fraction of capital).
 * @param tailFraction ES tail fraction.
 * @returns The change in ES (negative = improvement). Always finite.
 */
export function marginalExpectedShortfall(
    portfolioReturns: ReadonlyMap<string, number>,
    candidateReturns: ReadonlyMap<string, number>,
    candidateWeight: number,
    tailFraction: number,
): number {
    if (candidateWeight <= 0) return 0;
    const baseline: number[] = [];
    const withCandidate: number[] = [];
    for (const [k, v] of portfolioReturns) {
        if (!Number.isFinite(v)) continue;
        baseline.push(v);
        const cr = candidateReturns.get(k);
        if (cr !== undefined && Number.isFinite(cr)) {
            withCandidate.push(v + candidateWeight * cr);
        } else {
            withCandidate.push(v);
        }
    }
    if (baseline.length === 0) {
        // No portfolio yet; marginal ES is just the candidate's own ES (scaled).
        const candidateOnly: number[] = [];
        for (const v of candidateReturns.values()) {
            if (Number.isFinite(v)) candidateOnly.push(candidateWeight * v);
        }
        return historicalExpectedShortfall(candidateOnly, tailFraction);
    }
    const baseES = historicalExpectedShortfall(baseline, tailFraction);
    const newES = historicalExpectedShortfall(withCandidate, tailFraction);
    return newES - baseES;
}

// ---------------------------------------------------------------------------
// Non-finite guard for JSON safety (R13, "never stream NaN/Infinity")
// ---------------------------------------------------------------------------

export function finiteOrNull(value: number | null | undefined): number | null {
    return value !== null && value !== undefined && Number.isFinite(value) ? value : null;
}

export function finiteOrZero(value: number | null | undefined): number {
    return value !== null && value !== undefined && Number.isFinite(value) ? value : 0;
}
