/**
 * Descriptive classifier for the latest 200 valid ratio bars.
 *
 * This is deliberately separate from the long-history regime classifier. It
 * describes chart shape only; it is not a trade-quality or opportunity score.
 */

import type { OHLCVData } from "../types/strategies";
import { timeToNumber } from "../strategies/backtest/backtest-utils";

export const RECENT_PAIR_WINDOW_BARS = 200;
export const RECENT_SEGMENT_BARS = 50;
export const MAX_RECENT_PAIR_WINDOW_BARS = 100_000;

export interface RecentPairWindowOptions {
    /** 0 means all available bars before the holdout. */
    evalLastBars?: number;
    /** 0 means no reserved holdout. */
    oosIgnoreLastBars?: number;
}

export function normalizeRecentPairEvalLastBars(value: unknown): number {
    const numeric = typeof value === "number" || typeof value === "string"
        ? Number(value)
        : Number.NaN;
    if (!Number.isFinite(numeric)) return RECENT_PAIR_WINDOW_BARS;
    return Math.min(MAX_RECENT_PAIR_WINDOW_BARS, Math.max(0, Math.round(numeric)));
}

export function normalizeRecentPairOosIgnoreLastBars(value: unknown): number {
    const numeric = typeof value === "number" || typeof value === "string"
        ? Number(value)
        : Number.NaN;
    if (!Number.isFinite(numeric)) return 0;
    return Math.min(MAX_RECENT_PAIR_WINDOW_BARS, Math.max(0, Math.round(numeric)));
}

export type RecentPairType = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J";
export type RecentPairDirection = "BASE" | "NEUTRAL" | "QUOTE" | "THIN";
export type RecentPairReason =
    | "OK"
    | "INSUFFICIENT_BARS"
    | "INVALID_TIME"
    | "NO_VALID_CLOSES"
    | "ZERO_VARIANCE";

export interface RecentPairMetrics {
    barCount: number;
    asOf: number | null;
    ratioReturn: number | null;
    logReturn: number | null;
    pathEfficiency: number | null;
    reversalRate: number | null;
    volatilityRatio: number | null;
    baselineTrendStrength: number | null;
    recentTrendStrength: number | null;
    levelShiftSigma: number | null;
}

export interface RecentPairResult {
    symbol?: string;
    type: RecentPairType;
    direction: RecentPairDirection;
    label: string;
    reason: RecentPairReason;
    metrics: RecentPairMetrics;
}

const TREND_STRENGTH_THRESHOLD = 2.0;
const TREND_EFFICIENCY_THRESHOLD = 0.35;
const RANGE_EFFICIENCY_THRESHOLD = 0.30;
// Three or more direction changes across 199 returns distinguish repeated
// oscillation from a single round trip while allowing slower ranges.
const RANGE_REVERSAL_THRESHOLD = 0.015;
const EXPANDING_VOLATILITY_RATIO = 1.60;
const COMPRESSING_VOLATILITY_RATIO = 0.625;
const LEVEL_SHIFT_SIGMA_THRESHOLD = 2.50;

interface WindowStats {
    first: number;
    last: number;
    mean: number;
    levelStd: number;
    returnStd: number;
    slopeMove: number;
    pathEfficiency: number;
    reversalRate: number;
    trendStrength: number;
}

function mean(values: number[]): number {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStd(values: number[], center = mean(values)): number {
    if (values.length < 2) return 0;
    const variance = values.reduce((sum, value) => sum + (value - center) ** 2, 0)
        / (values.length - 1);
    return Math.sqrt(Math.max(0, variance));
}

function windowStats(values: number[]): WindowStats {
    const returns = values.slice(1).map((value, index) => value - values[index]);
    const returnStd = sampleStd(returns);
    let slopeNumerator = 0;
    let slopeDenominator = 0;
    const xMean = (values.length - 1) / 2;
    const yMean = mean(values);
    for (let i = 0; i < values.length; i += 1) {
        slopeNumerator += (i - xMean) * (values[i] - yMean);
        slopeDenominator += (i - xMean) ** 2;
    }
    const slopeMove = slopeDenominator > 0
        ? (slopeNumerator / slopeDenominator) * (values.length - 1)
        : 0;
    const pathLength = returns.reduce((sum, value) => sum + Math.abs(value), 0);
    let signChanges = 0;
    let eligibleTransitions = 0;
    for (let i = 1; i < returns.length; i += 1) {
        if (returns[i - 1] === 0 || returns[i] === 0) continue;
        eligibleTransitions += 1;
        if (Math.sign(returns[i - 1]) !== Math.sign(returns[i])) signChanges += 1;
    }
    const pathEfficiency = pathLength > 0
        ? Math.abs(values[values.length - 1] - values[0]) / pathLength
        : 0;
    const reversalRate = eligibleTransitions > 0
        ? signChanges / eligibleTransitions
        : 0;
    const trendStrength = returnStd > 0
        ? Math.abs(slopeMove) / (returnStd * Math.sqrt(values.length - 1))
        : slopeMove === 0 ? 0 : Number.POSITIVE_INFINITY;
    return {
        first: values[0],
        last: values[values.length - 1],
        mean: yMean,
        levelStd: sampleStd(values, yMean),
        returnStd,
        slopeMove,
        pathEfficiency,
        reversalRate,
        trendStrength,
    };
}

function emptyMetrics(barCount: number, asOf: number | null = null): RecentPairMetrics {
    return {
        barCount,
        asOf,
        ratioReturn: null,
        logReturn: null,
        pathEfficiency: null,
        reversalRate: null,
        volatilityRatio: null,
        baselineTrendStrength: null,
        recentTrendStrength: null,
        levelShiftSigma: null,
    };
}

function thinResult(reason: RecentPairReason, metrics: RecentPairMetrics): RecentPairResult {
    return {
        type: "J",
        direction: "THIN",
        label: "TYPE J — THIN",
        reason,
        metrics,
    };
}

function directionForMove(move: number): RecentPairDirection {
    if (move > 0) return "BASE";
    if (move < 0) return "QUOTE";
    return "NEUTRAL";
}

function labelFor(type: RecentPairType, direction: RecentPairDirection): string {
    const names: Record<RecentPairType, string> = {
        A: "STABLE RANGE",
        B: "EXPANDING RANGE",
        C: "COMPRESSING RANGE",
        D: "BASE TREND",
        E: "QUOTE TREND",
        F: "BREAKOUT",
        G: "REVERSAL",
        H: "LEVEL SHIFT",
        I: "MIXED / NOISY",
        J: "THIN",
    };
    if (type === "F" || type === "G") {
        return `TYPE ${type} — ${direction === "BASE" ? "BASE" : "QUOTE"} ${names[type]}`;
    }
    return `TYPE ${type} — ${names[type]}`;
}

function isRangeLike(stats: WindowStats): boolean {
    return stats.pathEfficiency <= RANGE_EFFICIENCY_THRESHOLD
        && stats.reversalRate >= RANGE_REVERSAL_THRESHOLD;
}

function isTrending(stats: WindowStats): boolean {
    return stats.trendStrength >= TREND_STRENGTH_THRESHOLD
        && stats.pathEfficiency >= TREND_EFFICIENCY_THRESHOLD;
}

function safeRatio(numerator: number, denominator: number): number {
    if (denominator === 0) return numerator === 0 ? 1 : Number.POSITIVE_INFINITY;
    return numerator / denominator;
}

/**
 * Classify the selected valid ratio closes after timestamp normalization,
 * deduplication, and chronological sorting. The default is the latest 200
 * bars; an optional holdout is removed before the evaluation-window cap.
 */
export function classifyRecentPair(
    bars: OHLCVData[],
    options: RecentPairWindowOptions = {},
): RecentPairResult {
    const byTime = new Map<number, number>();
    let validCloseCount = 0;
    for (const bar of bars) {
        const close = Number(bar.close);
        const time = timeToNumber(bar.time);
        if (Number.isFinite(close) && close > 0) validCloseCount += 1;
        if (time === null || !Number.isFinite(close) || close <= 0) continue;
        byTime.set(time, close);
    }
    if (byTime.size === 0) {
        return thinResult(
            validCloseCount === 0 ? "NO_VALID_CLOSES" : "INVALID_TIME",
            emptyMetrics(0),
        );
    }
    const points = Array.from(byTime.entries()).sort((a, b) => a[0] - b[0]);
    const evalLastBars = normalizeRecentPairEvalLastBars(options.evalLastBars);
    const oosIgnoreLastBars = normalizeRecentPairOosIgnoreLastBars(options.oosIgnoreLastBars);
    const visible = oosIgnoreLastBars > 0
        ? points.slice(0, Math.max(0, points.length - oosIgnoreLastBars))
        : points;
    const selected = evalLastBars > 0
        ? visible.slice(-evalLastBars)
        : visible;
    const asOf = selected[selected.length - 1]?.[0] ?? null;
    if (
        selected.length < 4
        || (evalLastBars > 0 && selected.length < evalLastBars)
    ) {
        return thinResult(
            "INSUFFICIENT_BARS",
            emptyMetrics(selected.length, asOf),
        );
    }

    const logCloses = selected.map(([, close]) => Math.log(close));
    const full = windowStats(logCloses);
    if (full.returnStd === 0 && full.slopeMove === 0) {
        return thinResult(
            "ZERO_VARIANCE",
            { ...emptyMetrics(selected.length, asOf), ratioReturn: 0, logReturn: 0 },
        );
    }
    // Preserve the original 150/50 split at the default 200-bar window. For
    // smaller explicit windows, scale the comparison blocks down so the
    // early/late evidence remains disjoint from the baseline/recent split.
    const segmentBars = Math.min(
        RECENT_SEGMENT_BARS,
        Math.max(2, Math.floor(selected.length / 4)),
    );
    const baseline = windowStats(logCloses.slice(0, -segmentBars));
    const recent = windowStats(logCloses.slice(-segmentBars));
    const early = windowStats(logCloses.slice(0, segmentBars));
    const volatilityRatio = safeRatio(recent.levelStd, early.levelStd);
    const pooledLevelStd = Math.sqrt((early.levelStd ** 2 + recent.levelStd ** 2) / 2);
    const levelShiftSigma = pooledLevelStd > 0
        ? Math.abs(recent.mean - early.mean) / pooledLevelStd
        : Math.abs(recent.mean - early.mean) > 0 ? Number.POSITIVE_INFINITY : 0;
    const metrics: RecentPairMetrics = {
        barCount: selected.length,
        asOf,
        ratioReturn: Math.exp(full.last - full.first) - 1,
        logReturn: full.last - full.first,
        pathEfficiency: full.pathEfficiency,
        reversalRate: full.reversalRate,
        volatilityRatio,
        baselineTrendStrength: baseline.trendStrength,
        recentTrendStrength: recent.trendStrength,
        levelShiftSigma,
    };

    const baselineRange = isRangeLike(baseline);
    const recentTrend = isTrending(recent);
    const baselineTrend = isTrending(baseline);
    const oppositeTrend = baselineTrend
        && recentTrend
        && Math.sign(baseline.slopeMove) !== Math.sign(recent.slopeMove);
    const earlyBlock = windowStats(logCloses.slice(0, Math.floor(selected.length / 2)));
    const lateBlock = windowStats(logCloses.slice(-Math.floor(selected.length / 2)));
    const stableEarlyLate = isRangeLike(earlyBlock)
        && isRangeLike(lateBlock)
        && levelShiftSigma >= LEVEL_SHIFT_SIGMA_THRESHOLD;
    const direction = directionForMove(
        recentTrend ? recent.slopeMove : full.slopeMove,
    );

    let type: RecentPairType;
    if (stableEarlyLate) {
        type = "H";
    } else if (oppositeTrend) {
        type = "G";
    } else if (!baselineTrend && recentTrend && baselineRange) {
        type = "F";
    } else if (isTrending(full)) {
        type = full.slopeMove >= 0 ? "D" : "E";
    } else if (isRangeLike(full)) {
        if (volatilityRatio >= EXPANDING_VOLATILITY_RATIO) type = "B";
        else if (volatilityRatio <= COMPRESSING_VOLATILITY_RATIO) type = "C";
        else type = "A";
    } else {
        type = "I";
    }

    return {
        type,
        direction: type === "D" ? "BASE"
            : type === "E" ? "QUOTE"
                : type === "F" || type === "G" ? direction
                    : type === "H" ? directionForMove(recent.mean - early.mean)
                        : "NEUTRAL",
        label: labelFor(
            type,
            type === "D" ? "BASE"
                : type === "E" ? "QUOTE"
                    : type === "F" || type === "G" ? direction
                        : type === "H" ? directionForMove(recent.mean - early.mean)
                            : "NEUTRAL",
        ),
        reason: "OK",
        metrics,
    };
}

const TYPE_ORDER: Record<RecentPairType, number> = {
    A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7, I: 8, J: 9,
};

export function compareRecentPairResults(
    a: RecentPairResult,
    b: RecentPairResult,
): number {
    const typeCmp = TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
    if (typeCmp !== 0) return typeCmp;
    const aStrength = Math.abs(a.metrics.recentTrendStrength ?? a.metrics.baselineTrendStrength ?? 0);
    const bStrength = Math.abs(b.metrics.recentTrendStrength ?? b.metrics.baselineTrendStrength ?? 0);
    if (aStrength !== bStrength) return bStrength - aStrength;
    return (a.symbol ?? "").localeCompare(b.symbol ?? "");
}

export function formatRecentPairMetrics(result: RecentPairResult): string {
    const m = result.metrics;
    return [
        `Return ${formatSignedPercent(m.ratioReturn)}`,
        `Eff ${formatNumber(m.pathEfficiency)}`,
        `Rev ${formatNumber(m.reversalRate)}`,
        `VolRatio ${formatNumber(m.volatilityRatio)}`,
        `Trend ${formatNumber(m.recentTrendStrength)}`,
        `Shift ${formatNumber(m.levelShiftSigma)}`,
        `Bars ${m.barCount}`,
        `asOf ${formatAsOf(m.asOf)}`,
    ].join(" | ");
}

function formatNumber(value: number | null): string {
    return value === null || !Number.isFinite(value) ? "n/a" : value.toFixed(2);
}

function formatSignedPercent(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return "n/a";
    return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

function formatAsOf(value: number | null): string {
    return value === null ? "n/a" : new Date(value * 1000).toISOString().slice(0, 10);
}
