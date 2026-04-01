import { Signal, Time, TradeFilterMode, MarketMode, PercentageTakeProfitMode } from './strategies';

export interface NormalizedSettings {
    atrPeriod: number;
    stopLossAtr: number;
    takeProfitAtr: number;
    trailingAtr: number;
    partialTakeProfitAtR: number;
    partialTakeProfitPercent: number;
    breakEvenAtR: number;
    /** Percentage-based break-even. When price moves this % in favor, stop → entry price. */
    breakEvenPercent: number;
    timeStopBars: number;

    riskMode: 'simple' | 'advanced' | 'percentage';
    stopLossPercent: number;
    takeProfitPercent: number;
    takeProfitMode: PercentageTakeProfitMode;
    takeProfitMfeLookbackTrades: number;
    takeProfitMfePercentile: number;
    takeProfitShrinkageStrength: number;
    takeProfitMomentumRsiPeriod: number;
    takeProfitMomentumRsiPauseLevel: number;
    takeProfitMomentumDecayPercentPerBar: number;
    takeProfitVelocityFastBars: number;
    takeProfitVelocitySlowBars: number;
    takeProfitVelocityProgressPercent: number;
    takeProfitVelocityExpandMultiplier: number;
    takeProfitVelocityShrinkMultiplier: number;
    takeProfitAtrScaledMultiplier: number;
    takeProfitRangeScaledLookback: number;
    takeProfitRangeScaledFraction: number;
    takeProfitMedianBarLookback: number;
    takeProfitMedianBarMultiplier: number;
    takeProfitMfeBootstrapPercentile: number;
    stopLossEnabled: boolean;
    takeProfitEnabled: boolean;
    riskMaxHoldBars: number;
    riskMaxHoldEnabled: boolean;
    riskWinStreakStopLossEnabled: boolean;
    riskWinStreakStopLossAfterWins: number;
    riskWinStreakStopLossPercent: number;
    flipAfterConsecutiveLosses: number;
    flipCooldownTrades: number;
    minTradesBeforeFirstFlip: number;

    trendEmaPeriod: number;
    htfBiasEmaPeriod: number;
    executionTrendEmaPeriod: number;
    trendPersistenceWindow: number;
    trendPersistenceMinBars: number;
    trendSlopeLookback: number;
    trendSlopeMinPercent: number;
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

    /** Maximum number of concurrently open positions (1 = classic, 2 = allow overlap) */
    maxOpenTrades: number;
    /** When true, queue skipped same-direction signals and execute on next bar if a position closes */
    warmUpEntryEnabled: boolean;

    // Snapshot-based trade filters
    snapshotAtrPercentMin: number;
    snapshotAtrPercentMax: number;
    snapshotVolumeRatioMin: number;
    snapshotVolumeRatioMax: number;
    snapshotAdxMin: number;
    snapshotAdxMax: number;
    snapshotEmaDistanceMin: number;
    snapshotEmaDistanceMax: number;
    snapshotRsiMin: number;
    snapshotRsiMax: number;
    snapshotPriceRangePosMin: number;
    snapshotPriceRangePosMax: number;
    snapshotBarsFromHighMax: number;
    snapshotBarsFromLowMax: number;
    snapshotTrendEfficiencyMin: number;
    snapshotTrendEfficiencyMax: number;
    snapshotAtrRegimeRatioMin: number;
    snapshotAtrRegimeRatioMax: number;
    snapshotBodyPercentMin: number;
    snapshotBodyPercentMax: number;
    snapshotWickSkewMin: number;
    snapshotWickSkewMax: number;
    snapshotVolumeTrendMin: number;
    snapshotVolumeTrendMax: number;
    snapshotVolumeBurstMin: number;
    snapshotVolumeBurstMax: number;
    snapshotVolumePriceDivergenceMin: number;
    snapshotVolumePriceDivergenceMax: number;
    snapshotVolumeConsistencyMin: number;
    snapshotVolumeConsistencyMax: number;
    snapshotCloseLocationMin: number;
    snapshotCloseLocationMax: number;
    snapshotOppositeWickMin: number;
    snapshotOppositeWickMax: number;
    snapshotRangeAtrMultipleMin: number;
    snapshotRangeAtrMultipleMax: number;
    snapshotMomentumConsistencyMin: number;
    snapshotMomentumConsistencyMax: number;
    snapshotBreakQualityMin: number;
    snapshotBreakQualityMax: number;
    snapshotTf60PerfMin: number;
    snapshotTf60PerfMax: number;
    snapshotTf90PerfMin: number;
    snapshotTf90PerfMax: number;
    snapshotTf120PerfMin: number;
    snapshotTf120PerfMax: number;
    snapshotTf480PerfMin: number;
    snapshotTf480PerfMax: number;
    snapshotTfConfluencePerfMin: number;
    snapshotTfConfluencePerfMax: number;
    snapshotEntryQualityScoreMin: number;
    snapshotEntryQualityScoreMax: number;
}

export interface IndicatorSeries {
    atr: (number | null)[];
    emaTrend: (number | null)[];
    emaFast: (number | null)[];
    emaSlow: (number | null)[];
    adx: (number | null)[];
    volumeSma: (number | null)[];
    rsi: (number | null)[];
    sessionVwap: (number | null)[];
    vwapDeviationStd: (number | null)[];
}

/**
 * Pre-computed indicators that can be reused across multiple backtest runs.
 * This saves significant computation time for large datasets in the finder.
 */
export interface PrecomputedIndicators extends IndicatorSeries {
    /** Source data reference for cache validation */
    readonly dataLength: number;
    /** Settings signature used to reject stale indicator bundles across candidate runs */
    readonly settingsKey: string;
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
    realizedPnl: number;
    /** True when this position was opened from a warm-up pending entry queue */
    warmUpEntry?: boolean;
}

export type KellyFraction = 'full' | 'half' | 'quarter';
export type VolScalingMethod = 'ewma' | 'sma' | 'expanding';
export type RiskParityMethod = 'var' | 'expected_shortfall' | 'historical_std';
export type MartingaleBaseSize = 'fixed' | 'percent';
export type SecureFMethod = 'bootstrap' | 'analytical';

export interface AdvancedSizingSettings {
    kellyFraction?: KellyFraction;
    kellyWinRateCap?: number;
    kellyProfitFactorCap?: number;
    volTargetAnnual?: number;
    volLookbackBars?: number;
    volScalingMethod?: VolScalingMethod;
    riskParityLookback?: number;
    riskParityMethod?: RiskParityMethod;
    martingaleMultiplier?: number;
    martingaleMaxSequence?: number;
    martingaleResetOnWin?: boolean;
    martingaleResetOnLoss?: boolean;
    martingaleBaseSize?: MartingaleBaseSize;
    optimalFLookback?: number;
    optimalFBootstrapSamples?: number;
    secureFConfidence?: number;
    secureFMethod?: SecureFMethod;
}

export const TRADE_SIZING_MODES = [
    'percent',
    'fixed',
    'smart_fixed_velocity_memory',
    'smart_fixed_quality_x_velocity',
    'kelly_criterion',
    'volatility_targeting',
    'risk_parity',
    'martingale',
    'anti_martingale',
    'optimal_f',
    'secure_f',
] as const;

export type TradeSizingMode = (typeof TRADE_SIZING_MODES)[number];

export function isTradeSizingMode(value: unknown): value is TradeSizingMode {
    return typeof value === 'string' && (TRADE_SIZING_MODES as readonly string[]).includes(value);
}

export function isSmartTradeSizingMode(mode: TradeSizingMode): boolean {
    return mode !== 'percent' && mode !== 'fixed';
}

export function isDirectFractionTradeSizingMode(mode: TradeSizingMode): boolean {
    return mode === 'kelly_criterion' || mode === 'optimal_f' || mode === 'secure_f';
}

export function usesFixedDollarSizing(mode: TradeSizingMode): boolean {
    return mode !== 'percent' && !isDirectFractionTradeSizingMode(mode);
}

export interface CapitalSettings {
    initialCapital: number;
    positionSize: number;
    commission: number;
    sizingMode: TradeSizingMode;
    fixedTradeAmount: number;
    advancedSizing?: AdvancedSizingSettings;
}

export interface TradeSizingConfig {
    mode: TradeSizingMode;
    fixedTradeAmount: number;
    advancedSizing?: AdvancedSizingSettings;
}

export interface PreparedSignal extends Signal {
    order: number;
}
