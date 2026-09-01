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
}

/** The identity/entry/features surface that trusted gate rules may inspect. */
export type TradeGateFeatureRow = Pick<
    TradeLedgerRow,
    | "ledgerVersion"
    | "pair"
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
}): TradeLedgerFeatureValues {
    const { data, series, signalBarIndex, signalSec, prior } = args;
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
    };
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
