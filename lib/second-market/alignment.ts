import { parseTimeToUnixSeconds } from "../time-normalization";
import type { OHLCVData } from "../types/strategies";
import type { PolymarketOutcomeRow } from "../types/polymarket-outcomes";
import type {
    AlignedClobQuote,
    AlignedGammaSnapshot,
    AlignedReferencePrice,
    PolymarketClob1sQuoteRow,
    PolymarketGammaSnapshotRow,
    PolymarketReference1sPriceRow,
    SecondMarketAlignmentMode,
    SecondMarketFillSource,
    SecondMarketOrderSide,
    SecondMarketSide,
} from "./types";

export const DEFAULT_MAX_QUOTE_AGE_SEC = 1;
export const DEFAULT_MAX_REFERENCE_AGE_SEC = 2;
export const DEFAULT_MAX_GAMMA_AGE_SEC = 60;

function parseFlags(value: string | null | undefined): string[] {
    if (!value) return [];
    return value
        .split(/[,\s]+/)
        .map((flag) => flag.trim())
        .filter(Boolean);
}

export function getClobQuoteTimeSec(row: PolymarketClob1sQuoteRow): number | null {
    const sampleTs = Number(row.sample_ts);
    return Number.isFinite(sampleTs) ? Math.floor(sampleTs) : null;
}

export function getReferenceTimeSec(row: PolymarketReference1sPriceRow): number | null {
    const sourceTsMs = Number(row.source_ts_ms);
    return Number.isFinite(sourceTsMs) ? Math.floor(sourceTsMs / 1000) : null;
}

function getCandleTimeSec(candle: OHLCVData): number | null {
    return parseTimeToUnixSeconds(candle.time);
}

function isUsableAge(ageSec: number, mode: SecondMarketAlignmentMode, maxAgeSec: number): boolean {
    if (ageSec < 0) return false;
    return mode === "strict" ? ageSec === 0 : ageSec <= maxAgeSec;
}

export function alignClobQuotesToCandles(
    candles: readonly OHLCVData[],
    quotes: readonly PolymarketClob1sQuoteRow[],
    options: {
        mode?: SecondMarketAlignmentMode;
        maxQuoteAgeSec?: number;
        targetShiftSec?: number;
    } = {}
): AlignedClobQuote[] {
    const mode = options.mode ?? "strict";
    const maxQuoteAgeSec = Math.max(0, Math.floor(options.maxQuoteAgeSec ?? DEFAULT_MAX_QUOTE_AGE_SEC));
    const targetShiftSec = Math.floor(options.targetShiftSec ?? 0);
    const sorted = quotes
        .map((quote) => ({ quote, quoteTs: getClobQuoteTimeSec(quote) }))
        .filter((item): item is { quote: PolymarketClob1sQuoteRow; quoteTs: number } => item.quoteTs !== null)
        .sort((left, right) =>
            left.quoteTs - right.quoteTs
            || (left.quote.source_ts_ms ?? 0) - (right.quote.source_ts_ms ?? 0)
            || left.quote.sample_ts - right.quote.sample_ts
        );

    const aligned: AlignedClobQuote[] = [];
    let pointer = 0;
    let latest: { quote: PolymarketClob1sQuoteRow; quoteTs: number } | null = null;

    for (const candle of candles) {
        const candleTs = getCandleTimeSec(candle);
        const targetTs = candleTs === null ? Number.NaN : candleTs + targetShiftSec;
        if (candleTs === null) {
            aligned.push({
                candleTime: candle.time,
                targetTs,
                quote: null,
                quoteTs: null,
                quoteAgeSec: null,
                hasExactClobQuote: false,
                qualityFlags: ["invalid_candle_time"],
            });
            continue;
        }

        while (pointer < sorted.length && sorted[pointer]!.quoteTs <= targetTs) {
            latest = sorted[pointer]!;
            pointer += 1;
        }

        const ageSec = latest ? targetTs - latest.quoteTs : null;
        const usableItem = latest !== null && ageSec !== null && isUsableAge(ageSec, mode, maxQuoteAgeSec)
            ? latest
            : null;
        aligned.push({
            candleTime: candle.time,
            targetTs,
            quote: usableItem ? usableItem.quote : null,
            quoteTs: usableItem ? usableItem.quoteTs : null,
            quoteAgeSec: usableItem ? ageSec : null,
            hasExactClobQuote: usableItem !== null && ageSec === 0,
            qualityFlags: usableItem ? parseFlags(usableItem.quote.quality_flags) : ["missing_clob_quote"],
        });
    }

    return aligned;
}

export function alignReferencePricesToCandles(
    candles: readonly OHLCVData[],
    prices: readonly PolymarketReference1sPriceRow[],
    options: {
        maxReferenceAgeSec?: number;
        targetShiftSec?: number;
    } = {}
): AlignedReferencePrice[] {
    const maxReferenceAgeSec = Math.max(0, Math.floor(options.maxReferenceAgeSec ?? DEFAULT_MAX_REFERENCE_AGE_SEC));
    const targetShiftSec = Math.floor(options.targetShiftSec ?? 0);
    const sorted = prices
        .map((reference) => ({ reference, referenceTs: getReferenceTimeSec(reference) }))
        .filter((item): item is { reference: PolymarketReference1sPriceRow; referenceTs: number } => item.referenceTs !== null)
        .sort((left, right) =>
            left.referenceTs - right.referenceTs
            || left.reference.source_ts_ms - right.reference.source_ts_ms
        );

    const aligned: AlignedReferencePrice[] = [];
    let pointer = 0;
    let latest: { reference: PolymarketReference1sPriceRow; referenceTs: number } | null = null;

    for (const candle of candles) {
        const candleTs = getCandleTimeSec(candle);
        const targetTs = candleTs === null ? Number.NaN : candleTs + targetShiftSec;
        if (candleTs === null) {
            aligned.push({
                candleTime: candle.time,
                targetTs,
                reference: null,
                referenceTs: null,
                referenceAgeSec: null,
                hasReferencePrice: false,
                qualityFlags: ["invalid_candle_time"],
            });
            continue;
        }

        while (pointer < sorted.length && sorted[pointer]!.referenceTs <= targetTs) {
            latest = sorted[pointer]!;
            pointer += 1;
        }

        const ageSec = latest ? targetTs - latest.referenceTs : null;
        const usableItem = latest !== null && ageSec !== null && ageSec >= 0 && ageSec <= maxReferenceAgeSec
            ? latest
            : null;
        aligned.push({
            candleTime: candle.time,
            targetTs,
            reference: usableItem ? usableItem.reference : null,
            referenceTs: usableItem ? usableItem.referenceTs : null,
            referenceAgeSec: usableItem ? ageSec : null,
            hasReferencePrice: usableItem !== null,
            qualityFlags: usableItem ? parseFlags(usableItem.reference.quality_flags) : ["missing_reference_price"],
        });
    }

    return aligned;
}

export function alignGammaSnapshotsToCandles(
    candles: readonly OHLCVData[],
    snapshots: readonly PolymarketGammaSnapshotRow[],
    options: {
        maxGammaAgeSec?: number;
        targetShiftSec?: number;
    } = {}
): AlignedGammaSnapshot[] {
    const maxGammaAgeSec = Math.max(0, Math.floor(options.maxGammaAgeSec ?? DEFAULT_MAX_GAMMA_AGE_SEC));
    const targetShiftSec = Math.floor(options.targetShiftSec ?? 0);
    const sorted = snapshots
        .slice()
        .sort((left, right) => left.snapshot_ts - right.snapshot_ts);

    const aligned: AlignedGammaSnapshot[] = [];
    let pointer = 0;
    let latest: PolymarketGammaSnapshotRow | null = null;

    for (const candle of candles) {
        const candleTs = getCandleTimeSec(candle);
        const targetTs = candleTs === null ? Number.NaN : candleTs + targetShiftSec;
        if (candleTs === null) {
            aligned.push({
                candleTime: candle.time,
                targetTs,
                gamma: null,
                snapshotTs: null,
                gammaAgeSec: null,
                hasGammaSnapshot: false,
                qualityFlags: ["invalid_candle_time"],
            });
            continue;
        }

        while (pointer < sorted.length && sorted[pointer]!.snapshot_ts <= targetTs) {
            latest = sorted[pointer]!;
            pointer += 1;
        }

        const ageSec = latest ? targetTs - latest.snapshot_ts : null;
        const usableItem = latest !== null && ageSec !== null && ageSec >= 0 && ageSec <= maxGammaAgeSec
            ? latest
            : null;
        aligned.push({
            candleTime: candle.time,
            targetTs,
            gamma: usableItem,
            snapshotTs: usableItem ? usableItem.snapshot_ts : null,
            gammaAgeSec: usableItem ? ageSec : null,
            hasGammaSnapshot: usableItem !== null,
            qualityFlags: usableItem ? [] : ["missing_gamma_snapshot"],
        });
    }

    return aligned;
}

export function findContainingPolymarketEvent(
    ts: number,
    outcomes: readonly PolymarketOutcomeRow[]
): PolymarketOutcomeRow | null {
    if (!Number.isFinite(ts)) return null;
    return outcomes.find((outcome) =>
        outcome.event_start_ts <= ts && ts < outcome.event_end_ts
    ) ?? null;
}

export function getClobSidePrice(
    quote: PolymarketClob1sQuoteRow,
    side: SecondMarketSide,
    orderSide: SecondMarketOrderSide,
    fillSource: SecondMarketFillSource = "bid_ask"
): number | null {
    const prefix = side === "yes" ? "yes" : "no";
    const value = (() => {
        if (fillSource === "mid") return quote[`${prefix}_mid` as "yes_mid" | "no_mid"];
        if (fillSource === "last") return quote[`${prefix}_last` as "yes_last" | "no_last"];
        return orderSide === "buy"
            ? quote[`${prefix}_ask` as "yes_ask" | "no_ask"]
            : quote[`${prefix}_bid` as "yes_bid" | "no_bid"];
    })();
    if (value === null || value === undefined || !Number.isFinite(value)) return null;
    return Math.max(0, Math.min(1, value));
}
