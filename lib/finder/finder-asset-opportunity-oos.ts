import type { OHLCVData } from "../types/strategies";

export const DEFAULT_FINDER_ASSET_OOS_HORIZONS = [1, 3, 5] as const;
const MAX_FINDER_ASSET_OOS_VALUE = 100_000;

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
