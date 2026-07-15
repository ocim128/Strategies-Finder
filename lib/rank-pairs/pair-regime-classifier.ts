/**
 * Pure calendar-aware pair-regime classifier.
 *
 * Replaces the first-to-last `relative-strength-score.ts`. The classifier
 * describes the synthetic ratio path (base.close / quote.close — see
 * docs/synthetic-pairs.md for the `BASE+QUOTE` = base/quote convention) with
 * fixed 30-calendar-day observations anchored at the latest candle, then emits
 * independent direction and structure labels.
 *
 * No DOM, no fetch, no shared state, no `Date.now()`. The browser service feeds
 * it the OHLCVData[] returned by the batch dataset loader and keeps only the
 * scalar result.
 *
 * Why calendar anchoring rather than bar-count returns: the batch loader serves
 * `30m`, `4h`, and `1d` intervals across both continuous crypto sessions and
 * stock sessions. Anchoring on 30-calendar-day marks makes the same ratio path
 * classify the same regardless of intra-period bar count, and avoids the
 * continuous-markets-only annualization the V1 scorer used.
 *
 * ⚠ LOOKAHEAD BIAS: classification spans a multiyear historical window. It is
 * research-only — a regime label is not a persistence claim, and ranking pairs
 * by a label measured over the same period you then backtest is lookahead.
 */

import type { OHLCVData } from "../types/strategies";
import { timeToNumber } from "../strategies/backtest/backtest-utils";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PairDirection = "BASE" | "NEUTRAL" | "QUOTE" | "THIN";
export type PairStructure =
    | "TREND"
    | "OSCILLATING"
    | "TRANSITION"
    | "REVERSAL"
    | "MIXED"
    | "THIN";

export type PairRegimeReason =
    | "OK"
    | "INSUFFICIENT_ANCHORS"
    | "INVALID_TIME"
    | "NO_VALID_CLOSES"
    | "ZERO_VARIANCE";

export interface PairRegimeMetrics {
    /** Valid (non-gap) anchored observations. */
    anchorCount: number;
    /** Raw OHLCV bars seen (post time/close validity filter, after dedup). */
    barCount: number;
    /** Latest selected candle time (unix seconds). */
    asOf: number | null;
    /** Calendar days between the earliest and latest valid observation. */
    elapsedDays: number | null;
    /** Simple ratio return: last/first - 1 over the valid window. */
    ratioReturn: number | null;
    /** Log return: ln(last) - ln(first). */
    logReturn: number | null;
    /** OLS log-price slope regressed on calendar years (log units / year). */
    annualizedSlope: number | null;
    /** Annualized stdev of 30-day periodic log returns. */
    annualizedVolatility: number | null;
    /** Annualized slope divided by annualized volatility. */
    normalizedDrift: number | null;
    /** abs(net log return) / sum(abs(periodic log returns)). */
    pathEfficiency: number | null;
    /** Sign changes between nonzero periodic returns / eligible transitions. */
    reversalRate: number | null;
    /** Whether the latest 7 anchors were gap-free (enables TRANSITION/REVERSAL). */
    hasRecentWindow: boolean;
    /** Normalized drift over the recent (latest 7 anchors) window. */
    recentNormalizedDrift: number | null;
    /** Path efficiency over the recent window. */
    recentPathEfficiency: number | null;
    /** last/first close ratio. */
    endpointRatio: number | null;
    /** True when endpointRatio sits inside the reciprocal [1/1.30, 1.30] band. */
    endpointInsideBand: boolean | null;
    /**
     * Drift used for display and within-group sorting: recent drift for
     * TRANSITION/REVERSAL (the label describes the current regime), full drift
     * otherwise.
     */
    currentNormalizedDrift: number | null;
}

export interface PairRegimeResult {
    /** Optional symbol tag for deterministic tie-break sorting. Set by callers. */
    symbol?: string;
    direction: PairDirection;
    structure: PairStructure;
    /** Combined display label, e.g. "BASE / TREND". */
    label: string;
    reason: PairRegimeReason;
    metrics: PairRegimeMetrics;
}

// ---------------------------------------------------------------------------
// Thresholds (named — changing any is a behavior change requiring test updates)
// ---------------------------------------------------------------------------

/** 30-calendar-day observation spacing. */
export const ANCHOR_INTERVAL_DAYS = 30;
/** Latest observation plus 36 preceding anchors (~3 years). */
export const TOTAL_ANCHORS = 37;
/** Reject an anchor whose nearest candle is older than this (calendar days). */
export const MAX_ANCHOR_AGE_DAYS = 7;
/** Minimum valid (non-gap) anchors required to escape THIN. */
export const MIN_VALID_ANCHORS = 33;
/** Minimum elapsed calendar days required to escape THIN. */
export const MIN_ELAPSED_DAYS = 960;
/** Latest N consecutive anchors forming the recent window (6 returns). */
export const RECENT_ANCHOR_COUNT = 7;
/** Reciprocal endpoint band bound: [1/BAND, BAND]. */
export const ENDPOINT_BAND = 1.30;

// Classification thresholds.
export const DRIFT_THRESHOLD = 0.50; // |normalized drift| for TREND / direction
export const TREND_EFFICIENCY_THRESHOLD = 0.25;
export const RECENT_DRIFT_THRESHOLD = 0.75;
export const RECENT_EFFICIENCY_THRESHOLD = 0.40;
export const OSCILLATING_EFFICIENCY_THRESHOLD = 0.20;
export const OSCILLATING_REVERSAL_RATE_THRESHOLD = 0.50;

/**
 * Below this annualized volatility, the series is numerically a pure trend
 * (variance is floating-point residue, e.g. a deterministic exponential). Vol
 * is clamped up to this floor so normalized drift stays bounded instead of
 * exploding to ~1e15. Pair with MAX_NORMALIZED_DRIFT.
 */
export const VOL_FLOOR_EPS = 1e-6;
/**
 * Cap on |normalized drift|. A path at the vol floor is a perfect trend; its
 * exact drift magnitude is meaningless, so it is clamped to this cap rather
 * than allowed to dominate within-group sorting.
 */
export const MAX_NORMALIZED_DRIFT = 10;

// ---------------------------------------------------------------------------
// Internal time constants
// ---------------------------------------------------------------------------

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_YEAR = 365 * SECONDS_PER_DAY;
const ANCHOR_INTERVAL_SECONDS = ANCHOR_INTERVAL_DAYS * SECONDS_PER_DAY;
const MAX_ANCHOR_AGE_SECONDS = MAX_ANCHOR_AGE_DAYS * SECONDS_PER_DAY;

// ---------------------------------------------------------------------------
// Anchor selection + metric computation
// ---------------------------------------------------------------------------

interface AnchorPoint {
    time: number;
    close: number;
}

function mean(xs: number[]): number {
    if (xs.length === 0) return 0;
    let s = 0;
    for (const x of xs) s += x;
    return s / xs.length;
}

/**
 * OLS slope of y on x (both arrays same length). Returns log-units of y per
 * unit of x. Caller passes x in years so the slope is per calendar year.
 */
function olsSlope(xs: number[], ys: number[]): number {
    if (xs.length < 2) return 0;
    const xm = mean(xs);
    const ym = mean(ys);
    let num = 0;
    let den = 0;
    for (let i = 0; i < xs.length; i++) {
        num += (xs[i] - xm) * (ys[i] - ym);
        den += (xs[i] - xm) * (xs[i] - xm);
    }
    return den > 0 ? num / den : 0;
}

/**
 * Build the anchored observation series. Returns an array of length up to
 * TOTAL_ANCHORS in DESCENDING time order (index 0 = most recent). `null` marks
 * an anchor whose nearest candle was older than the tolerance.
 *
 * `points` must be sorted ascending by time with duplicate timestamps already
 * collapsed (last-write-wins).
 */
function selectAnchors(points: AnchorPoint[]): (AnchorPoint | null)[] {
    if (points.length === 0) return [];
    const latestTime = points[points.length - 1].time;
    const observations: (AnchorPoint | null)[] = [];

    // Anchors are generated descending from the latest candle. A single pointer
    // into the ascending `points` array only moves left as anchors move back.
    let p = points.length - 1;
    for (let i = 0; i < TOTAL_ANCHORS; i++) {
        const anchorT = latestTime - i * ANCHOR_INTERVAL_SECONDS;
        while (p >= 0 && points[p].time > anchorT) p--;
        if (p < 0) break; // every earlier anchor is also unresolvable
        const candle = points[p];
        const age = anchorT - candle.time;
        observations.push(age > MAX_ANCHOR_AGE_SECONDS ? null : candle);
    }
    return observations;
}

/**
 * Slope, vol, normalized drift, and path efficiency over a set of anchors.
 *
 * Volatility uses each return's actual elapsed calendar duration. A return
 * spanning 60 or 90 days contributes variance over that longer interval
 * instead of being treated as another 30-day return. See VOL_FLOOR_EPS /
 * MAX_NORMALIZED_DRIFT for near-zero-variance handling.
 */
function driftMetrics(asc: AnchorPoint[]) {
    if (asc.length < 2) {
        return {
            slope: 0 as number,
            vol: 0 as number,
            normalizedDrift: null as number | null,
            efficiency: null as number | null,
            periodReturns: [] as number[],
        };
    }
    const logCloses = asc.map((o) => Math.log(o.close));
    const tYears = asc.map((o) => (o.time - asc[0].time) / SECONDS_PER_YEAR);

    // OLS slope regresses log-price on actual calendar years, so it is already
    // gap-correct (a gap is just a wider x-spacing).
    const slope = olsSlope(tYears, logCloses); // log units / year

    // Returns with their actual elapsed durations. periodReturns[i] is the log
    // return from anchor i to anchor i+1; periodYears[i] is that span in years.
    const periodReturns: number[] = [];
    const periodYears: number[] = [];
    for (let i = 1; i < asc.length; i++) {
        const dtYears = (asc[i].time - asc[i - 1].time) / SECONDS_PER_YEAR;
        if (dtYears <= 0) continue; // defensive: duplicate-time dedup should prevent this
        periodReturns.push(logCloses[i] - logCloses[i - 1]);
        periodYears.push(dtYears);
    }

    // Estimate variance per calendar year from returns with unequal durations.
    // Annualizing every return before taking stdev would scale volatility by
    // 1/dt. Volatility scales with 1/sqrt(dt), so that approach overstates a
    // uniform 30-day series by sqrt(365/30), suppressing normalized drift.
    const vol = durationWeightedVol(periodReturns, periodYears);

    // Clamp near-zero variance so a deterministic trend does not explode drift
    // to ~1e15. The path is then reported at the MAX_NORMALIZED_DRIFT cap.
    const effectiveVol = Math.max(vol, VOL_FLOOR_EPS);
    const rawDrift = slope / effectiveVol;
    const clampedDrift = Math.max(-MAX_NORMALIZED_DRIFT, Math.min(MAX_NORMALIZED_DRIFT, rawDrift));
    // vol strictly > 0 after the floor; normalizedDrift is always defined here.
    const normalizedDrift = clampedDrift;

    const firstLog = logCloses[0];
    const lastLog = logCloses[logCloses.length - 1];
    let sumAbs = 0;
    for (const r of periodReturns) sumAbs += Math.abs(r);
    const efficiency = sumAbs > 0 ? Math.abs(lastLog - firstLog) / sumAbs : null;

    return { slope, vol, normalizedDrift, efficiency, periodReturns };
}

/**
 * Annualized volatility for returns with unequal elapsed durations. For
 * uniform spacing this is `sampleStdev(returns) / sqrt(periodYears)`.
 */
function durationWeightedVol(returns: number[], years: number[]): number {
    if (returns.length < 2) return 0;
    let totalReturn = 0;
    let totalYears = 0;
    for (let i = 0; i < returns.length; i++) {
        totalReturn += returns[i];
        totalYears += years[i];
    }
    if (totalYears <= 0) return 0;

    const driftPerYear = totalReturn / totalYears;
    let residualSumSquares = 0;
    for (let i = 0; i < returns.length; i++) {
        const residual = returns[i] - driftPerYear * years[i];
        residualSumSquares += residual * residual;
    }
    const sampleCorrection = returns.length / (returns.length - 1);
    return Math.sqrt((residualSumSquares / totalYears) * sampleCorrection);
}

function reversalRateOf(periodReturns: number[]): number | null {
    let eligible = 0;
    let signChanges = 0;
    for (let i = 1; i < periodReturns.length; i++) {
        const a = periodReturns[i - 1];
        const b = periodReturns[i];
        if (a !== 0 && b !== 0) {
            eligible++;
            if (Math.sign(a) !== Math.sign(b)) signChanges++;
        }
    }
    return eligible > 0 ? signChanges / eligible : null;
}

function emptyMetrics(barCount: number): PairRegimeMetrics {
    return {
        anchorCount: 0,
        barCount,
        asOf: null,
        elapsedDays: null,
        ratioReturn: null,
        logReturn: null,
        annualizedSlope: null,
        annualizedVolatility: null,
        normalizedDrift: null,
        pathEfficiency: null,
        reversalRate: null,
        hasRecentWindow: false,
        recentNormalizedDrift: null,
        recentPathEfficiency: null,
        endpointRatio: null,
        endpointInsideBand: null,
        currentNormalizedDrift: null,
    };
}

function thinResult(reason: PairRegimeReason, metrics: PairRegimeMetrics): PairRegimeResult {
    return { direction: "THIN", structure: "THIN", label: "THIN / THIN", reason, metrics };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Classify a synthetic ratio series into a direction + structure regime.
 *
 * Pure and deterministic: same input always yields the same result. The input
 * `bars` are the aligned ratio candles from the batch dataset loader; interval
 * is intentionally NOT a parameter — calendar anchoring makes 30m/4h/1d paths
 * comparable.
 */
export function classifyPairRegime(bars: OHLCVData[]): PairRegimeResult {
    // 1. Normalize time + close, dedup last-write-wins, sort ascending by time.
    const byTime = new Map<number, AnchorPoint>();
    let validCloseCount = 0;
    for (const bar of bars) {
        const t = timeToNumber(bar.time);
        const c = Number(bar.close);
        if (Number.isFinite(c) && c > 0) validCloseCount++;
        if (t === null || !Number.isFinite(c) || c <= 0) continue;
        byTime.set(t, { time: t, close: c });
    }

    if (byTime.size === 0) {
        const reason: PairRegimeReason =
            validCloseCount === 0 ? "NO_VALID_CLOSES" : "INVALID_TIME";
        return thinResult(reason, emptyMetrics(0));
    }

    const points: AnchorPoint[] = Array.from(byTime.values()).sort(
        (a, b) => a.time - b.time,
    );
    const barCount = points.length;

    // 2. Anchor selection.
    const observations = selectAnchors(points);
    const validObs = observations.filter((o): o is AnchorPoint => o !== null);
    const anchorCount = validObs.length;
    const asOf = observations[0]?.time ?? points[points.length - 1].time;

    // Coverage guard.
    if (anchorCount < MIN_VALID_ANCHORS) {
        return thinResult("INSUFFICIENT_ANCHORS", {
            ...emptyMetrics(barCount),
            anchorCount,
            asOf,
        });
    }

    // Chronological (ascending) valid observations for metric math.
    const asc = validObs.slice().sort((a, b) => a.time - b.time);
    const firstObs = asc[0];
    const lastObs = asc[asc.length - 1];
    const elapsedDays = (lastObs.time - firstObs.time) / SECONDS_PER_DAY;

    if (elapsedDays < MIN_ELAPSED_DAYS) {
        return thinResult("INSUFFICIENT_ANCHORS", {
            ...emptyMetrics(barCount),
            anchorCount,
            asOf,
            elapsedDays,
        });
    }

    // 3. Metrics.
    const full = driftMetrics(asc);
    if (full.efficiency === null) {
        // sumAbs === 0 → constant series.
        return thinResult("ZERO_VARIANCE", {
            ...emptyMetrics(barCount),
            anchorCount,
            asOf,
            elapsedDays,
        });
    }

    const firstClose = firstObs.close;
    const lastClose = lastObs.close;
    const ratioReturn = lastClose / firstClose - 1;
    const logReturn = Math.log(lastClose) - Math.log(firstClose);
    const reversalRate = reversalRateOf(full.periodReturns);
    const endpointRatio = lastClose / firstClose;
    const endpointInsideBand =
        endpointRatio >= 1 / ENDPOINT_BAND && endpointRatio <= ENDPOINT_BAND;

    // Recent window: latest RECENT_ANCHOR_COUNT anchors must be gap-free.
    const recentSlice = observations.slice(0, RECENT_ANCHOR_COUNT);
    const hasRecentWindow =
        recentSlice.length === RECENT_ANCHOR_COUNT && recentSlice.every(Boolean);
    let recentNormalizedDrift: number | null = null;
    let recentPathEfficiency: number | null = null;
    if (hasRecentWindow) {
        const recentAsc = (recentSlice as AnchorPoint[]).slice().sort((a, b) => a.time - b.time);
        const recent = driftMetrics(recentAsc);
        recentNormalizedDrift = recent.normalizedDrift;
        recentPathEfficiency = recent.efficiency;
    }

    // The pre-recent baseline ends at the first recent anchor. Sharing that
    // boundary point gives the baseline and recent windows non-overlapping
    // returns. Without this separation, the recent move can make the "full"
    // window look trending and hide the transition it is meant to detect.
    const baselineAsc = observations
        .slice(RECENT_ANCHOR_COUNT - 1)
        .filter((o): o is AnchorPoint => o !== null)
        .sort((a, b) => a.time - b.time);
    const baseline = driftMetrics(baselineAsc);

    const metrics: PairRegimeMetrics = {
        anchorCount,
        barCount,
        asOf,
        elapsedDays,
        ratioReturn,
        logReturn,
        annualizedSlope: full.slope,
        annualizedVolatility: full.vol,
        normalizedDrift: full.normalizedDrift,
        pathEfficiency: full.efficiency,
        reversalRate,
        hasRecentWindow,
        recentNormalizedDrift,
        recentPathEfficiency,
        endpointRatio,
        endpointInsideBand,
        // currentNormalizedDrift filled after structure is decided below.
        currentNormalizedDrift: null,
    };

    // 4. Classification (precedence exactly as specified).
    const driftAbs =
        full.normalizedDrift !== null ? Math.abs(full.normalizedDrift) : null;
    const fullIsTrending =
        full.normalizedDrift !== null &&
        full.efficiency !== null &&
        driftAbs! >= DRIFT_THRESHOLD &&
        full.efficiency >= TREND_EFFICIENCY_THRESHOLD;
    const baselineDriftAbs =
        baseline.normalizedDrift !== null
            ? Math.abs(baseline.normalizedDrift)
            : null;
    const baselineIsTrending =
        baseline.normalizedDrift !== null &&
        baseline.efficiency !== null &&
        baselineDriftAbs! >= DRIFT_THRESHOLD &&
        baseline.efficiency >= TREND_EFFICIENCY_THRESHOLD;
    const baselineReversalRate = reversalRateOf(baseline.periodReturns);
    const baselineEndpointRatio =
        baselineAsc.length >= 2
            ? baselineAsc[baselineAsc.length - 1].close / baselineAsc[0].close
            : null;
    const baselineIsOscillating =
        baselineEndpointRatio !== null &&
        baselineEndpointRatio >= 1 / ENDPOINT_BAND &&
        baselineEndpointRatio <= ENDPOINT_BAND &&
        baseline.efficiency !== null &&
        baseline.efficiency <= OSCILLATING_EFFICIENCY_THRESHOLD &&
        baselineReversalRate !== null &&
        baselineReversalRate >= OSCILLATING_REVERSAL_RATE_THRESHOLD;

    const recentDriftAbs =
        recentNormalizedDrift !== null ? Math.abs(recentNormalizedDrift) : null;
    const recentStrong =
        hasRecentWindow &&
        recentDriftAbs !== null &&
        recentDriftAbs >= RECENT_DRIFT_THRESHOLD &&
        recentPathEfficiency !== null &&
        recentPathEfficiency >= RECENT_EFFICIENCY_THRESHOLD;
    const recentOppositeBaseline =
        recentStrong &&
        baselineIsTrending &&
        baseline.normalizedDrift !== null &&
        recentNormalizedDrift !== null &&
        Math.sign(baseline.normalizedDrift) !== Math.sign(recentNormalizedDrift);

    let structure: PairStructure;
    if (recentOppositeBaseline) {
        structure = "REVERSAL";
    } else if (recentStrong && baselineIsTrending) {
        structure = "TREND";
    } else if (recentStrong && baselineIsOscillating) {
        structure = "TRANSITION";
    } else if (recentStrong) {
        // Recent direction alone is not evidence of a regime change. Keep an
        // ambiguous historical baseline explicit instead of promoting every
        // six-month move to TRANSITION or TREND.
        structure = "MIXED";
    } else if (fullIsTrending) {
        structure = "TREND";
    } else if (
        endpointInsideBand &&
        full.efficiency <= OSCILLATING_EFFICIENCY_THRESHOLD &&
        reversalRate !== null &&
        reversalRate >= OSCILLATING_REVERSAL_RATE_THRESHOLD
    ) {
        structure = "OSCILLATING";
    } else {
        structure = "MIXED";
    }

    // 5. Direction. TRANSITION/REVERSAL describe the current regime, so they
    // use recent drift; others use full drift.
    const driftForDirection =
        structure === "REVERSAL" || structure === "TRANSITION"
            ? recentNormalizedDrift
            : full.normalizedDrift;
    const direction = directionFromDrift(driftForDirection);

    metrics.currentNormalizedDrift = driftForDirection;

    return {
        direction,
        structure,
        label: `${direction} / ${structure}`,
        reason: "OK",
        metrics,
    };
}

export function directionFromDrift(drift: number | null): PairDirection {
    if (drift === null) return "NEUTRAL";
    if (drift >= DRIFT_THRESHOLD) return "BASE";
    if (drift <= -DRIFT_THRESHOLD) return "QUOTE";
    return "NEUTRAL";
}

// ---------------------------------------------------------------------------
// Sorting (display ordering — NOT a trade-quality score)
// ---------------------------------------------------------------------------

const STRUCTURE_GROUP_ORDER: Record<PairStructure, number> = {
    TRANSITION: 0,
    REVERSAL: 1,
    TREND: 2,
    OSCILLATING: 3,
    MIXED: 4,
    THIN: 5,
};

/**
 * Deterministic display comparator for two regime results. Failed/no-data rows
 * are handled by the caller (they sort after every regime result). THIN results
 * fall into group 5 and tie-break by symbol.
 */
export function comparePairRegimeResults(
    a: PairRegimeResult,
    b: PairRegimeResult,
): number {
    const ga = STRUCTURE_GROUP_ORDER[a.structure];
    const gb = STRUCTURE_GROUP_ORDER[b.structure];
    if (ga !== gb) return ga - gb;

    if (a.structure === "OSCILLATING") {
        const ra = a.metrics.reversalRate ?? -Infinity;
        const rb = b.metrics.reversalRate ?? -Infinity;
        if (ra !== rb) return rb - ra; // reversal rate desc
        const ea = a.metrics.pathEfficiency ?? Infinity;
        const eb = b.metrics.pathEfficiency ?? Infinity;
        if (ea !== eb) return ea - eb; // efficiency asc
    } else if (
        a.structure === "TRANSITION" ||
        a.structure === "REVERSAL" ||
        a.structure === "TREND"
    ) {
        const da = Math.abs(a.metrics.currentNormalizedDrift ?? -Infinity);
        const db = Math.abs(b.metrics.currentNormalizedDrift ?? -Infinity);
        if (da !== db) return db - da; // |current drift| desc
    }

    // Final tie-breaker: symbol (ascending, case-sensitive — callers uppercase).
    const sa = a.symbol ?? "";
    const sb = b.symbol ?? "";
    if (sa !== sb) return sa < sb ? -1 : 1;
    return 0;
}

// ---------------------------------------------------------------------------
// Formatting helpers (pure — no DOM)
// ---------------------------------------------------------------------------

export function formatPercent(x: number | null, digits = 1): string {
    if (x === null || !Number.isFinite(x)) return "n/a";
    const sign = x >= 0 ? "+" : "";
    return `${sign}${(x * 100).toFixed(digits)}%`;
}

export function formatFixed(x: number | null, digits = 2): string {
    if (x === null || !Number.isFinite(x)) return "n/a";
    return x.toFixed(digits);
}

/** Format a unix-seconds timestamp as a UTC ISO date (YYYY-MM-DD). */
export function formatAsOf(asOf: number | null): string {
    if (asOf === null || !Number.isFinite(asOf)) return "n/a";
    return new Date(asOf * 1000).toISOString().slice(0, 10);
}
