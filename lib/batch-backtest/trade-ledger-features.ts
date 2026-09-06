/** Shared causal feature computation for the trade ledger and Trade Gate. */

import { calculateATR } from "../strategies/indicators";
import { parseTimeToUnixSeconds } from "../time-normalization";
import type { OHLCVData, Trade } from "../types/strategies";
import {
    TRADE_LEDGER_FEATURE_ATR_PERIOD,
    TRADE_LEDGER_FEATURE_RETURN_BARS,
    TRADE_LEDGER_PAIR_WIN_RATE_MIN_PRIOR,
    type TradeLedgerRow,
    type TradeLedgerDirection,
} from "./trade-ledger-schema";

export interface TradeLedgerFeatureSeries {
    closes: number[];
    highs: number[];
    lows: number[];
    barSecs: (number | null)[];
    atr: (number | null)[];
}

export interface TradeLedgerPriorStats {
    trades: number;
    wins: number;
}

export interface TradeLedgerFeatureValues {
    feat_entryRangePosition: number | null;
    feat_atrPct: number | null;
    feat_return20: number | null;
    feat_gapPct: number | null;
    feat_dow: number | null;
    feat_hour: number | null;
    feat_pairWinRatePrior: number | null;
    feat_pairTradesPrior: number;
    feat_pairSpreadVolatility20: number | null;
    feat_legVolatilityRatio20: number | null;
}

/** The identity/entry/features surface that trusted gate rules may inspect. */
export type TradeGateFeatureRow = Pick<
    TradeLedgerRow,
    | "ledgerVersion"
    | "pair"
    | "baseSymbol"
    | "quoteSymbol"
    | "direction"
    | "signalTime"
    | "signalBarIndex"
    | "fillTime"
    | "fillPrice"
    | "feat_entryRangePosition"
    | "feat_atrPct"
    | "feat_return20"
    | "feat_gapPct"
    | "feat_dow"
    | "feat_hour"
    | "feat_pairWinRatePrior"
    | "feat_pairTradesPrior"
    | "feat_barsSincePairLastFire"
    | "feat_pairSpreadVolatility20"
    | "feat_legVolatilityRatio20"
    | "feat_candidatesAtTime"
>;

export function buildTradeLedgerFeatureSeries(data: readonly OHLCVData[]): TradeLedgerFeatureSeries {
    const closes: number[] = new Array(data.length);
    const highs: number[] = new Array(data.length);
    const lows: number[] = new Array(data.length);
    const barSecs: (number | null)[] = new Array(data.length);
    for (let i = 0; i < data.length; i += 1) {
        const bar = data[i]!;
        closes[i] = bar.close;
        highs[i] = bar.high;
        lows[i] = bar.low;
        barSecs[i] = parseTimeToUnixSeconds(bar.time);
    }
    return {
        closes,
        highs,
        lows,
        barSecs,
        atr: calculateATR(highs, lows, closes, TRADE_LEDGER_FEATURE_ATR_PERIOD),
    };
}

export function buildTradeLedgerFeatureValues(args: {
    data: readonly OHLCVData[];
    series: TradeLedgerFeatureSeries;
    signalBarIndex: number;
    signalSec: number;
    prior: TradeLedgerPriorStats;
    baseCloses?: readonly (number | null)[];
    quoteCloses?: readonly (number | null)[];
}): TradeLedgerFeatureValues {
    const { data, series, signalBarIndex, signalSec, prior, baseCloses, quoteCloses } = args;
    const { closes, highs, lows, atr } = series;
    return {
        feat_entryRangePosition:
            signalBarIndex >= 1 && highs[signalBarIndex - 1]! > lows[signalBarIndex - 1]!
                ? (closes[signalBarIndex]! - lows[signalBarIndex - 1]!)
                  / (highs[signalBarIndex - 1]! - lows[signalBarIndex - 1]!)
                  * 100
                : null,
        feat_atrPct:
            atr[signalBarIndex] != null && closes[signalBarIndex]! > 0
                ? (atr[signalBarIndex]! / closes[signalBarIndex]!) * 100
                : null,
        feat_return20:
            signalBarIndex >= TRADE_LEDGER_FEATURE_RETURN_BARS
            && closes[signalBarIndex - TRADE_LEDGER_FEATURE_RETURN_BARS]! > 0
                ? (closes[signalBarIndex]! - closes[signalBarIndex - TRADE_LEDGER_FEATURE_RETURN_BARS]!)
                  / closes[signalBarIndex - TRADE_LEDGER_FEATURE_RETURN_BARS]!
                  * 100
                : null,
        feat_gapPct:
            signalBarIndex >= 1 && closes[signalBarIndex - 1]! > 0
                ? (data[signalBarIndex]!.open - closes[signalBarIndex - 1]!)
                  / closes[signalBarIndex - 1]!
                  * 100
                : null,
        feat_dow: utcField(signalSec, (date) => date.getUTCDay()),
        feat_hour: utcField(signalSec, (date) => date.getUTCHours()),
        feat_pairWinRatePrior:
            prior.trades >= TRADE_LEDGER_PAIR_WIN_RATE_MIN_PRIOR
                ? (prior.wins / prior.trades) * 100
                : null,
        feat_pairTradesPrior: prior.trades,
        feat_pairSpreadVolatility20: buildVolatility20(closes, signalBarIndex),
        feat_legVolatilityRatio20: buildLegVolatilityRatio20(
            baseCloses,
            quoteCloses,
            signalBarIndex,
        ),
    };
}

/**
 * Population standard deviation of the twenty one-bar returns immediately
 * before the signal bar. The close at the signal bar is never read.
 */
export function buildVolatility20(
    closes: readonly (number | null)[] | undefined,
    signalBarIndex: number,
): number | null {
    if (!closes || signalBarIndex < TRADE_LEDGER_FEATURE_RETURN_BARS) return null;
    const changes: number[] = [];
    for (
        let k = signalBarIndex - TRADE_LEDGER_FEATURE_RETURN_BARS;
        k < signalBarIndex;
        k += 1
    ) {
        const previous = closes[k - 1];
        const current = closes[k];
        if (
            previous == null
            || current == null
            || !Number.isFinite(previous)
            || !Number.isFinite(current)
            || previous <= 0
            || current <= 0
        ) {
            return null;
        }
        changes.push(((current - previous) / previous) * 100);
    }
    return populationStandardDeviation(changes);
}

export function buildLegVolatilityRatio20(
    baseCloses: readonly (number | null)[] | undefined,
    quoteCloses: readonly (number | null)[] | undefined,
    signalBarIndex: number,
): number | null {
    const baseVolatility = buildVolatility20(baseCloses, signalBarIndex);
    const quoteVolatility = buildVolatility20(quoteCloses, signalBarIndex);
    if (baseVolatility === null || quoteVolatility === null || quoteVolatility === 0) return null;
    return baseVolatility / quoteVolatility;
}

function populationStandardDeviation(values: readonly number[]): number | null {
    if (values.length !== TRADE_LEDGER_FEATURE_RETURN_BARS) return null;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return Math.sqrt(variance);
}

export function tradeGateSignalKey(signalBarIndex: number, direction: TradeLedgerDirection): string {
    return `${signalBarIndex}|${direction}`;
}

export function toTradeGateFeatureRow(
    row: TradeLedgerRow,
    candidatesAtTime: number | null,
): TradeGateFeatureRow {
    return {
        ledgerVersion: row.ledgerVersion,
        pair: row.pair,
        baseSymbol: row.baseSymbol,
        quoteSymbol: row.quoteSymbol,
        direction: row.direction,
        signalTime: row.signalTime,
        signalBarIndex: row.signalBarIndex,
        fillTime: row.fillTime,
        fillPrice: row.fillPrice,
        feat_entryRangePosition: row.feat_entryRangePosition,
        feat_atrPct: row.feat_atrPct,
        feat_return20: row.feat_return20,
        feat_gapPct: row.feat_gapPct,
        feat_dow: row.feat_dow,
        feat_hour: row.feat_hour,
        feat_pairWinRatePrior: row.feat_pairWinRatePrior,
        feat_pairTradesPrior: row.feat_pairTradesPrior,
        feat_barsSincePairLastFire: row.feat_barsSincePairLastFire,
        feat_pairSpreadVolatility20: row.feat_pairSpreadVolatility20,
        feat_legVolatilityRatio20: row.feat_legVolatilityRatio20,
        feat_candidatesAtTime: candidatesAtTime,
    };
}

function utcField(signalSec: number, read: (date: Date) => number): number {
    return read(new Date(signalSec * 1000));
}

/** Kept as a shared helper for parity tests and callers that hold Trade arrays. */
export function summarizePriorTrades(trades: readonly Trade[]): TradeLedgerPriorStats {
    let wins = 0;
    for (const trade of trades) {
        if (trade.pnlPercent > 0) wins += 1;
    }
    return { trades: trades.length, wins };
}
