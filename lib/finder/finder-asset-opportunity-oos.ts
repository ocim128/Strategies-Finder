import type { OHLCVData, Time, Trade } from "../types/strategies";
import { parseTimeToUnixSeconds } from "../time-normalization";

export const DEFAULT_FINDER_ASSET_OOS_HORIZONS = [1, 3, 5] as const;
export const MAX_FINDER_ASSET_OOS_VALUE = 100_000;

/** Inclusive batch range cap; larger sweeps must be split into smaller runs. */
export const MAX_FINDER_ASSET_OOS_BATCH_VALUES = 1000;

export interface FinderAssetOosHorizonMetric {
    /** Forward close-to-entry PnL, summed across eligible OOS entries. */
    bars: number;
    pnlPercent: number | null;
    averagePnlPercent: number | null;
    winRatePercent: number | null;
    sampleSize: number;
}

export interface FinderAssetOosMetrics {
    /** Number of historical bars excluded from IS candidate search. */
    ignoreLastBars: number;
    /** Price series used for fixed-horizon measurement; missing on older pair/asset-based archives. */
    basis?: FinderAssetOosHorizonBasis;
    horizons: FinderAssetOosHorizonMetric[];
}

export type FinderAssetOosNextExitStatus = "exited" | "censored" | "unavailable";
export type FinderAssetOosNextExitUnavailableReason =
    | "no_boundary_trade"
    | "missing_exit_reason"
    | "replay_error";
export type FinderAssetOosMeasurementMode = "fixed_horizon" | "next_exit";
export type FinderAssetEvalWindowMode = "fixed" | "range_bar";
export type FinderAssetOosHorizonBasis = "pair" | "base_only";

export interface FinderAssetOosNextExitMetrics {
    /** Number of hidden candles available as the maximum observation window. */
    ignoreLastBars: number;
    status: FinderAssetOosNextExitStatus;
    /** Realized engine PnL, including modeled costs; null when censored/unavailable. */
    pnlPercent: number | null;
    exitReason: NonNullable<Trade["exitReason"]> | null;
    /** Why the next-exit observation could not be classified, when unavailable. */
    unavailableReason: FinderAssetOosNextExitUnavailableReason | null;
    barsHeld: number | null;
    exitTime: Time | null;
}

export interface FinderAssetOosAverageHorizonMetric {
    bars: number;
    averagePnlPercent: number | null;
    sampleSize: number;
}

export function normalizeFinderAssetOosMeasurementMode(value: unknown): FinderAssetOosMeasurementMode {
    return value === "next_exit" ? "next_exit" : "fixed_horizon";
}

export function normalizeFinderAssetEvalWindowMode(value: unknown): FinderAssetEvalWindowMode {
    return value === "range_bar" ? "range_bar" : "fixed";
}

export function normalizeFinderAssetOosHorizonBasis(value: unknown): FinderAssetOosHorizonBasis {
    return value === "base_only" ? "base_only" : "pair";
}

/**
 * Average each forward-validation horizon across the currently displayed
 * Asset Opportunity results. Horizons remain separate so a 5-bar result is
 * never averaged together with a 12- or 15-bar result.
 */
export function calculateFinderAssetOosAverageHorizonMetrics(
    metrics: readonly (FinderAssetOosMetrics | null | undefined)[],
): FinderAssetOosAverageHorizonMetric[] {
    const totals = new Map<number, { total: number; sampleSize: number }>();
    for (const resultMetrics of metrics) {
        for (const horizon of resultMetrics?.horizons ?? []) {
            const value = horizon.averagePnlPercent;
            if (value === null || !Number.isFinite(value)) continue;
            const current = totals.get(horizon.bars) ?? { total: 0, sampleSize: 0 };
            current.total += value;
            current.sampleSize += 1;
            totals.set(horizon.bars, current);
        }
    }

    return [...totals.entries()].map(([bars, aggregate]) => ({
        bars,
        averagePnlPercent: aggregate.sampleSize > 0
            ? aggregate.total / aggregate.sampleSize
            : null,
        sampleSize: aggregate.sampleSize,
    }));
}

function buildHorizonMetrics(args: {
    candles: readonly OHLCVData[];
    baseCandlesByTime?: ReadonlyMap<number, OHLCVData>;
    signalIndex: number;
    entryPrice: number;
    direction: "long" | "short";
    horizons: readonly number[];
}): FinderAssetOosHorizonMetric[] {
    const normalizedHorizons = normalizeFinderAssetOosHorizons(args.horizons);
    return normalizedHorizons.map((bars) => {
        const targetCandle = args.candles[args.signalIndex + bars];
        const targetTime = targetCandle ? parseTimeToUnixSeconds(targetCandle.time) : null;
        const targetClose = args.baseCandlesByTime
            ? (targetTime === null ? undefined : args.baseCandlesByTime.get(targetTime)?.close)
            : targetCandle?.close;
        const directionFactor = args.direction === "short" ? -1 : 1;
        const pnlPercent = typeof targetClose === "number"
            && Number.isFinite(targetClose)
            && Number.isFinite(args.entryPrice)
            && args.entryPrice > 0
            ? directionFactor * ((targetClose - args.entryPrice) / args.entryPrice) * 100
            : Number.NaN;
        return {
            bars,
            pnlPercent: Number.isFinite(pnlPercent) ? pnlPercent : null,
            averagePnlPercent: Number.isFinite(pnlPercent) ? pnlPercent : null,
            winRatePercent: Number.isFinite(pnlPercent) ? (pnlPercent > 0 ? 100 : 0) : null,
            sampleSize: Number.isFinite(pnlPercent) ? 1 : 0,
        };
    });
}

export function normalizeFinderAssetOosIgnoreLastBars(value: unknown): number {
    const numeric = typeof value === "number" || typeof value === "string"
        ? Number(value)
        : Number.NaN;
    if (!Number.isFinite(numeric)) return 0;
    return Math.min(MAX_FINDER_ASSET_OOS_VALUE, Math.max(0, Math.round(numeric)));
}

export function normalizeFinderAssetEvalLastBars(value: unknown): number {
    const numeric = typeof value === "number" || typeof value === "string"
        ? Number(value)
        : Number.NaN;
    if (!Number.isFinite(numeric)) return 0;
    return Math.min(MAX_FINDER_ASSET_OOS_VALUE, Math.max(0, Math.round(numeric)));
}

/** Resolve the effective IS cap for one holdout iteration. */
export function resolveFinderAssetEvalWindowBars(
    evalLastBarsValue: unknown,
    holdoutBarsValue: unknown,
    modeValue: unknown,
): number {
    const evalLastBars = normalizeFinderAssetEvalLastBars(evalLastBarsValue);
    if (evalLastBars === 0 || normalizeFinderAssetEvalWindowMode(modeValue) === "fixed") {
        return evalLastBars;
    }
    return normalizeFinderAssetEvalLastBars(
        evalLastBars + normalizeFinderAssetOosIgnoreLastBars(holdoutBarsValue),
    );
}

/**
 * Result of validating an inclusive batch holdout range. `error === null`
 * means the range is valid and `start`/`end` are ordered positive integers
 * with `end - start + 1` within {@link MAX_FINDER_ASSET_OOS_BATCH_VALUES}.
 */
export interface FinderAssetOosBatchHoldoutRange {
    start: number;
    end: number;
    error: string | null;
}

/**
 * Validate an inclusive holdout range for Asset Opportunity batch mode.
 * Positive integers only (no `0`, which is the single-run "no holdout"
 * sentinel), ascending order, per-value cap at
 * {@link MAX_FINDER_ASSET_OOS_VALUE}, and an at-most-1000-value range cap so
 * a batch cannot accidentally schedule runaway work. Returns the ordered
 * range or a validation error; never throws.
 */
export function normalizeFinderAssetOosBatchHoldoutRange(
    startValue: unknown,
    endValue: unknown,
): FinderAssetOosBatchHoldoutRange {
    const parseInteger = (value: unknown): number => {
        const numeric = typeof value === "number" || typeof value === "string"
            ? Number(value)
            : Number.NaN;
        return Number.isInteger(numeric) ? numeric : Number.NaN;
    };
    const start = parseInteger(startValue);
    const end = parseInteger(endValue);
    if (!Number.isFinite(start) || start <= 0 || start > MAX_FINDER_ASSET_OOS_VALUE) {
        return {
            start: 0,
            end: 0,
            error: `Batch OOS start must be a positive integer at most ${MAX_FINDER_ASSET_OOS_VALUE}.`,
        };
    }
    if (!Number.isFinite(end) || end <= 0 || end > MAX_FINDER_ASSET_OOS_VALUE) {
        return {
            start: 0,
            end: 0,
            error: `Batch OOS end must be a positive integer at most ${MAX_FINDER_ASSET_OOS_VALUE}.`,
        };
    }
    if (start > end) {
        return {
            start: 0,
            end: 0,
            error: "Batch OOS start must not exceed the end value.",
        };
    }
    if (end - start + 1 > MAX_FINDER_ASSET_OOS_BATCH_VALUES) {
        return {
            start: 0,
            end: 0,
            error: `Batch OOS range must contain at most ${MAX_FINDER_ASSET_OOS_BATCH_VALUES} holdout values.`,
        };
    }
    return { start, end, error: null };
}

/**
 * Normalize the user/server boundary to exactly three positive integer
 * horizons. Invalid or incomplete input falls back to the documented default.
 */
export function normalizeFinderAssetOosHorizons(value: unknown): number[] {
    const raw = Array.isArray(value)
        ? value
        : typeof value === "string"
            ? value.split(/[\s,]+/u).filter(Boolean)
            : [];
    const horizons: number[] = [];
    for (const entry of raw) {
        const numeric = typeof entry === "number" || typeof entry === "string"
            ? Number(entry)
            : Number.NaN;
        if (!Number.isInteger(numeric) || numeric <= 0 || numeric > MAX_FINDER_ASSET_OOS_VALUE) {
            return [...DEFAULT_FINDER_ASSET_OOS_HORIZONS];
        }
        if (!horizons.includes(numeric)) horizons.push(numeric);
    }
    return horizons.length === DEFAULT_FINDER_ASSET_OOS_HORIZONS.length
        ? horizons
        : [...DEFAULT_FINDER_ASSET_OOS_HORIZONS];
}

/**
 * Measure one boundary signal against the hidden future window. The signal
 * candle is outside the holdout, so horizon 1 targets the first hidden candle,
 * horizon 3 targets the third hidden candle, and so on.
 */
export function calculateFinderAssetOosSignalMetrics(args: {
    candles: readonly OHLCVData[];
    baseCandlesByTime?: ReadonlyMap<number, OHLCVData>;
    signalIndex: number;
    entryPrice: number;
    direction: "long" | "short";
    ignoreLastBars: number;
    horizons: readonly number[];
    basis?: FinderAssetOosHorizonBasis;
}): FinderAssetOosMetrics {
    return {
        ignoreLastBars: normalizeFinderAssetOosIgnoreLastBars(args.ignoreLastBars),
        basis: normalizeFinderAssetOosHorizonBasis(args.basis),
        horizons: buildHorizonMetrics(args),
    };
}

/**
 * First index whose candle time equals `time` (exact match on the time-sorted
 * ascending candle array), or -1 when absent/unparseable. Binary-search
 * replacement for the per-call `findIndex` full scans in the boundary metrics
 * below; identical first-match semantics on duplicate timestamps.
 */
function findCandleIndexByUnixTime(candles: readonly OHLCVData[], time: number | null): number {
    if (time === null) return -1;
    let low = 0;
    let high = candles.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const middleTime = parseTimeToUnixSeconds(candles[middle]!.time);
        if (middleTime === null) return -1;
        if (middleTime < time) low = middle + 1;
        else high = middle;
    }
    return low < candles.length && parseTimeToUnixSeconds(candles[low]!.time) === time ? low : -1;
}

/**
 * Extract the first engine-recorded exit for the boundary entry. The caller
 * replays the complete timeline; this leaf only matches the entry and turns
 * its first trade event into a scalar OOS observation.
 */
export function calculateFinderAssetOosNextExitMetrics(args: {
    candles: readonly OHLCVData[];
    boundaryEntryTime: Time | null;
    direction: "long" | "short";
    ignoreLastBars: number;
    trades: readonly Trade[];
    unavailableReason?: FinderAssetOosNextExitUnavailableReason;
}): FinderAssetOosNextExitMetrics {
    const ignoreLastBars = normalizeFinderAssetOosIgnoreLastBars(args.ignoreLastBars);
    const boundaryEntrySeconds = parseTimeToUnixSeconds(args.boundaryEntryTime);
    const trade = boundaryEntrySeconds === null
        ? undefined
        : args.trades.find((candidate) => (
            candidate.type === args.direction
            && parseTimeToUnixSeconds(candidate.entryTime) === boundaryEntrySeconds
        ));
    if (!trade || !trade.exitReason) {
        return {
            ignoreLastBars,
            status: "unavailable",
            pnlPercent: null,
            exitReason: null,
            unavailableReason: args.unavailableReason
                ?? (trade ? "missing_exit_reason" : "no_boundary_trade"),
            barsHeld: null,
            exitTime: null,
        };
    }

    const entryIndex = findCandleIndexByUnixTime(args.candles, boundaryEntrySeconds);
    const exitSeconds = parseTimeToUnixSeconds(trade.exitTime);
    const exitIndex = findCandleIndexByUnixTime(args.candles, exitSeconds);
    const barsHeld = entryIndex >= 0 && exitIndex >= entryIndex
        ? exitIndex - entryIndex
        : null;
    const censored = trade.exitReason === "end_of_data";
    return {
        ignoreLastBars,
        status: censored ? "censored" : "exited",
        pnlPercent: censored || !Number.isFinite(trade.pnlPercent) ? null : trade.pnlPercent,
        exitReason: trade.exitReason,
        unavailableReason: null,
        barsHeld,
        exitTime: trade.exitTime,
    };
}
