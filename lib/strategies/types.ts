import type { Time } from "lightweight-charts";
export type { Time };

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface OHLCVData {
    time: Time;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface Trade {
    id: number;
    type: 'long' | 'short';
    entryTime: Time;
    entryPrice: number;
    exitTime: Time;
    exitPrice: number;
    pnl: number;
    pnlPercent: number;
    size: number;
    fees?: number;
}

export interface BacktestResult {
    trades: Trade[];
    netProfit: number;
    netProfitPercent: number;
    winRate: number;
    expectancy: number;
    avgTrade: number;
    profitFactor: number;
    maxDrawdown: number;
    maxDrawdownPercent: number;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    avgWin: number;
    avgLoss: number;
    sharpeRatio: number;
    equityCurve: { time: Time; value: number }[];
    entryStats?: EntryStats;
}

export interface StrategyParams {
    [key: string]: number;
}

export type TradeFilterMode = 'none' | 'close' | 'volume' | 'rsi' | 'trend' | 'adx';
/** @deprecated Use TradeFilterMode. */
export type EntryConfirmationMode = TradeFilterMode;
export type TradeDirection = 'long' | 'short' | 'both';
export type ExecutionModel = 'signal_close' | 'next_open' | 'next_close';
export type MarketMode = 'all' | 'uptrend' | 'downtrend' | 'sideway';

export interface BacktestSettings {
    atrPeriod?: number;
    stopLossAtr?: number;
    takeProfitAtr?: number;
    trailingAtr?: number;
    partialTakeProfitAtR?: number;
    partialTakeProfitPercent?: number;
    breakEvenAtR?: number;
    timeStopBars?: number;

    // Risk management percentage mode
    riskMode?: 'simple' | 'advanced' | 'percentage';
    stopLossPercent?: number;
    takeProfitPercent?: number;
    stopLossEnabled?: boolean;
    takeProfitEnabled?: boolean;

    trendEmaPeriod?: number;
    trendEmaSlopeBars?: number;
    atrPercentMin?: number;
    atrPercentMax?: number;
    adxPeriod?: number;
    adxMin?: number;
    adxMax?: number;

    tradeFilterMode?: TradeFilterMode;
    /** @deprecated Use tradeFilterMode. */
    entryConfirmation?: TradeFilterMode;
    confirmLookback?: number;
    volumeSmaPeriod?: number;
    volumeMultiplier?: number;
    rsiPeriod?: number;
    rsiBullish?: number;
    rsiBearish?: number;
    marketMode?: MarketMode;
    /** Optional list of strategy keys used as additional trade filters */
    confirmationStrategies?: string[];
    /** Optional parameter overrides for confirmation strategies */
    confirmationStrategyParams?: Record<string, StrategyParams>;
    tradeDirection?: TradeDirection;
    /** Execution timing model for signal fills */
    executionModel?: ExecutionModel;
    /** Allow exits on the same bar as entry */
    allowSameBarExit?: boolean;
    /** Slippage in basis points (bps) applied to entry/exit fills */
    slippageBps?: number;
}

export interface Signal {
    time: Time;
    type: 'buy' | 'sell';
    price: number;
    reason?: string;
    /** Optional bar index to align execution timing in backtests/replay. */
    barIndex?: number;
}

export interface EntryStats {
    mode: 'fan_retest';
    winDefinition?: 'retest' | 'target';
    targetPct?: number;
    avgTargetBars?: number;
    levels?: EntryLevelStat[];
    selectedLevel?: number;
    selectedLevelIndex?: number;
    totalEntries: number;
    wins: number;
    losses: number;
    winRate: number;
    avgRetestBars: number;
    avgRetests: number;
    maxBars: number;
    maxRetests: number;
    minRetestsForWin: number;
    entryMode: number;
    retestMode: number;
    useWick: boolean;
    touchTolerancePct: number;
}

export interface EntryLevelStat {
    level: number;
    totalEntries: number;
    wins: number;
    losses: number;
    winRate: number;
    avgRetestBars: number;
    avgRetests: number;
    avgTargetBars?: number;
}

export interface EntryPreview {
    mode: number;
    direction: 'long' | 'short' | 'both' | 'none';
    level: number;
    fanPrice: number | null;
    lastClose: number | null;
    distance: number | null;
    distancePct: number | null;
    status: 'triggered' | 'waiting' | 'unavailable';
    note?: string;
}

export interface StrategyEvaluation {
    signals: Signal[];
    entryStats?: EntryStats;
}

export interface StrategyIndicator {
    name: string;
    type: 'line' | 'band' | 'histogram';
    values: (number | null)[] | { [key: string]: (number | null)[] };
    color?: string;
}

export interface Strategy {
    name: string;
    description: string;
    defaultParams: StrategyParams;
    paramLabels: { [key: string]: string };
    execute: (data: OHLCVData[], params: StrategyParams) => Signal[];
    evaluate?: (data: OHLCVData[], params: StrategyParams, signals?: Signal[]) => StrategyEvaluation;
    indicators?: (data: OHLCVData[], params: StrategyParams) => StrategyIndicator[];
    /** Optional entry preview for live chart hinting */
    entryPreview?: (data: OHLCVData[], params: StrategyParams) => EntryPreview | null;
    /** Optional metadata for strategy */
    metadata?: {
        /** Role this strategy plays (entry, filter, exit, regime) */
        role?: 'entry' | 'filter' | 'exit' | 'regime';
        /** Trading direction capability (long, short, both) */
        direction?: 'long' | 'short' | 'both';
        /** Optional allowlist for walk-forward/quick analysis parameter optimization */
        walkForwardParams?: string[];
    };
}

