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
    horizons: FinderAssetOosHorizonMetric[];
}

export type FinderAssetOosNextExitStatus = "exited" | "censored" | "unavailable";
export type FinderAssetOosNextExitUnavailableReason =
    | "no_boundary_trade"
    | "missing_exit_reason"
    | "replay_error";
export type FinderAssetOosMeasurementMode = "fixed_horizon" | "next_exit";

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
    signalIndex: number;
    entryPrice: number;
    direction: "long" | "short";
    horizons: readonly number[];
}): FinderAssetOosHorizonMetric[] {
    const normalizedHorizons = normalizeFinderAssetOosHorizons(args.horizons);
    return normalizedHorizons.map((bars) => {
        const targetClose = args.candles[args.signalIndex + bars]?.close;
        const directionFactor = args.direction === "short" ? -1 : 1;
        const pnlPercent = Number.isFinite(args.entryPrice)
            && args.entryPrice > 0
            && Number.isFinite(targetClose)
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
    signalIndex: number;
    entryPrice: number;
    direction: "long" | "short";
    ignoreLastBars: number;
    horizons: readonly number[];
}): FinderAssetOosMetrics {
    return {
        ignoreLastBars: normalizeFinderAssetOosIgnoreLastBars(args.ignoreLastBars),
        horizons: buildHorizonMetrics(args),
    };
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

    const entryIndex = boundaryEntrySeconds === null
        ? -1
        : args.candles.findIndex((candle) => parseTimeToUnixSeconds(candle.time) === boundaryEntrySeconds);
    const exitSeconds = parseTimeToUnixSeconds(trade.exitTime);
    const exitIndex = exitSeconds === null
        ? -1
        : args.candles.findIndex((candle) => parseTimeToUnixSeconds(candle.time) === exitSeconds);
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
