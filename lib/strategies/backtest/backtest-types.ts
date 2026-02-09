
import { Signal, Time, TradeFilterMode, MarketMode } from '../types';

export interface NormalizedSettings {
    atrPeriod: number;
    stopLossAtr: number;
    takeProfitAtr: number;
    trailingAtr: number;
    partialTakeProfitAtR: number;
    partialTakeProfitPercent: number;
    breakEvenAtR: number;
    timeStopBars: number;

    riskMode: 'simple' | 'advanced' | 'percentage';
    stopLossPercent: number;
    takeProfitPercent: number;
    stopLossEnabled: boolean;
    takeProfitEnabled: boolean;

    trendEmaPeriod: number;
    trendEmaSlopeBars: number;
    atrPercentMin: number;
    atrPercentMax: number;
    adxPeriod: number;
    adxMin: number;
    adxMax: number;

    tradeFilterMode: TradeFilterMode;
    confirmLookback: number;
    volumeSmaPeriod: number;
    volumeMultiplier: number;
    rsiPeriod: number;
    rsiBullish: number;
    rsiBearish: number;
    marketMode: MarketMode;
    executionModel: 'signal_close' | 'next_open' | 'next_close';
    allowSameBarExit: boolean;
    slippageBps: number;
}

export interface IndicatorSeries {
    atr: (number | null)[];
    emaTrend: (number | null)[];
    adx: (number | null)[];
    volumeSma: (number | null)[];
    rsi: (number | null)[];
}

/**
 * Pre-computed indicators that can be reused across multiple backtest runs.
 * This saves significant computation time for large datasets in the finder.
 */
export interface PrecomputedIndicators extends IndicatorSeries {
    /** Source data reference for cache validation */
    readonly dataLength: number;
}

export interface PositionState {
    direction: 'long' | 'short';
    entryTime: Time;
    entryPrice: number;
    size: number;
    entryCommissionPerShare: number;
    stopLossPrice: number | null;
    takeProfitPrice: number | null;
    riskPerShare: number;
    barsInTrade: number;
    extremePrice: number;
    partialTargetPrice: number | null;
    partialTaken: boolean;
    breakEvenApplied: boolean;
}

export interface TradeSizingConfig {
    mode: 'percent' | 'fixed';
    fixedTradeAmount: number;
}

export interface PreparedSignal extends Signal {
    order: number;
}
