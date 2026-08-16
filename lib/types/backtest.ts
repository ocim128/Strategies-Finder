import { Time, MarketMode, PercentageTakeProfitMode, PathExitMode } from './strategies';

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
    takeProfitMfeBootstrapPercentile: number;
    takeProfitAdaptiveLookbackTrades: number;
    takeProfitAdaptiveRecentWindow: number;
    takeProfitAdaptiveMinMultiplier: number;
    takeProfitAdaptiveMaxMultiplier: number;
    takeProfitAdaptiveGridSteps: number;
    takeProfitAdaptiveRegimeBlend: number;
    takeProfitAdaptiveIcScale: number;
    stopLossEnabled: boolean;
    takeProfitEnabled: boolean;
    riskMinHoldBars: number;
    riskMinHoldEnabled: boolean;
    riskMaxHoldBars: number;
    riskMaxHoldEnabled: boolean;
    riskCooldownEnabled: boolean;
    riskCooldownBars: number;
    riskWinStreakStopLossEnabled: boolean;
    riskWinStreakStopLossAfterWins: number;
    riskWinStreakStopLossPercent: number;
    disableSignalExits: boolean;
    pathExitEnabled: boolean;
    pathExitMode: PathExitMode;
    pathExitMinBars: number;
    pathExitMinMfePercent: number;
    pathExitGivebackPercent: number;
    pathExitLookbackBars: number;
    pathExitThreshold: number;
    pathExitMinSamples: number;
    pathExitHorizonBars: number;

    trendEmaPeriod: number;
    trendEmaSlopeBars: number;
    atrPercentMin: number;
    atrPercentMax: number;
    adxPeriod: number;
    adxMin: number;
    adxMax: number;

    marketMode: MarketMode;
    executionModel: 'signal_close' | 'next_open' | 'next_close';
    allowSameBarExit: boolean;
    slippageBps: number;

    /** Maximum number of concurrently open positions (1–2 = capped overlap, Infinity = unlimited overlap) */
    maxOpenTrades: number;
}

/**
 * Settings-level DOM value that selects unlimited overlap. Values below it cap
 * concurrent positions at their own number (1 = classic, 2 = capped overlap);
 * `normalizeBacktestSettings` maps this value (and above) to Infinity.
 */
export const MAX_OPEN_TRADES_UNLIMITED = 3;

export interface IndicatorSeries {
    atr: (number | null)[];
    emaTrend: (number | null)[];
    adx: (number | null)[];
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
    /**
     * Transient engine bookkeeping: the bar index at which the position was
     * last (re-)opened, so the simulation loop can detect same-bar entries
     * without allocating a Set per bar. Undefined for positions constructed
     * outside the engine (e.g. tests); those are treated as "not opened this
     * bar" by the loop, matching prior Set-based behavior.
     */
    openedBarIndex?: number;
    /**
     * Transient engine bookkeeping: the first bar of the current same-direction
     * overlap group. Max-hold exits use this anchor so later entries cannot
     * extend the group's total exposure window.
     */
    maxHoldGroupEntryBarIndex?: number;
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
