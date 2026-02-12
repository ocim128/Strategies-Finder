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

/** Indicator snapshot captured at trade entry for pattern analysis */
export interface TradeSnapshot {
    rsi: number | null;
    adx: number | null;
    /** ATR as percentage of price */
    atrPercent: number | null;
    /** % distance from trend EMA (positive = above, negative = below) */
    emaDistance: number | null;
    /** volume / volume SMA ratio */
    volumeRatio: number | null;
    /** position in recent N-bar range (0 = at low, 1 = at high) */
    priceRangePos: number | null;
    /** bars since recent high */
    barsFromHigh: number | null;
    /** bars since recent low */
    barsFromLow: number | null;
    /** Kaufman efficiency ratio over recent bars (0 = choppy, 1 = directional) */
    trendEfficiency: number | null;
    /** ATR regime ratio (current ATR / ATR lookback average) */
    atrRegimeRatio: number | null;
    /** Candle body size as % of bar range (0-100) */
    bodyPercent: number | null;
    /** Wick imbalance % (-100..100): positive upper-wick bias, negative lower-wick bias */
    wickSkew: number | null;
    /** Directional close location in the candle (0-100, higher = stronger close in trade direction) */
    closeLocation?: number | null;
    /** Wick against trade direction as % of candle range (0-100, lower is better) */
    oppositeWickPercent?: number | null;
    /** Candle range / ATR ratio (volatility sanity check) */
    rangeAtrMultiple?: number | null;
    /** % of supportive candles over recent window (default 3 bars) */
    momentumConsistency?: number | null;
    /** Breakout close quality score (0-100, higher = cleaner close beyond trigger) */
    breakQuality?: number | null;
    /** Directional performance over prior 60 minutes (%, positive = aligned with entry) */
    tf60Perf?: number | null;
    /** Directional performance over prior 90 minutes (%, positive = aligned with entry) */
    tf90Perf?: number | null;
    /** Directional performance over prior 120 minutes (%, positive = aligned with entry) */
    tf120Perf?: number | null;
    /** Directional performance over prior 480 minutes (%, positive = aligned with entry) */
    tf480Perf?: number | null;
    /** Multi-timeframe directional confluence % (higher = broad timeframe alignment) */
    tfConfluencePerf?: number | null;
    /** Composite entry quality score (0-100) from candle-based sub-metrics */
    entryQualityScore?: number | null;
    /** Volume trend ratio (short EMA / long EMA, >1 = building) */
    volumeTrend: number | null;
    /** Relative volume burst z-score */
    volumeBurst: number | null;
    /** Volume-price agreement (-1..1, negative = divergence) */
    volumePriceDivergence: number | null;
    /** Volume consistency (coeff of variation, lower = steadier) */
    volumeConsistency: number | null;
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
    /** Exit reason: how the trade was closed */
    exitReason?: 'signal' | 'stop_loss' | 'take_profit' | 'trailing_stop' | 'time_stop' | 'partial' | 'end_of_data';
    /** Stop-loss price level (populated for open/EOD trades) */
    stopLossPrice?: number | null;
    /** Take-profit price level (populated for open/EOD trades) */
    takeProfitPrice?: number | null;
    /** Indicator snapshot at entry for pattern analysis */
    entrySnapshot?: TradeSnapshot;
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
    postEntryPath?: PostEntryPathStats;
}

export interface PostEntryPathBucketStats {
    avgSignedMovePctByBar: Array<number | null>;
    medianSignedMovePctByBar: Array<number | null>;
    maxSignedMovePctByBar: Array<number | null>;
    minSignedMovePctByBar: Array<number | null>;
    positiveRatePctByBar: Array<number | null>;
    sampleSizeByBar: number[];
    avgClosedTradeTimeBars: number | null;
    avgClosedTradeTimeMinutes: number | null;
}

export interface PostEntryPathOpenTradeProbability {
    hasOpenTrade: boolean;
    tradeType: 'long' | 'short' | null;
    barsHeld: number | null;
    basisBar: number | null;
    signedMovePct: number | null;
    winProbabilityPct: number | null;
    loseProbabilityPct: number | null;
    sampleSize: number;
    matchedSampleSize: number;
}

export interface PostEntryPathStats {
    horizonBars: number[];
    win: PostEntryPathBucketStats;
    lose: PostEntryPathBucketStats;
    all: PostEntryPathBucketStats;
    openTradeProbability: PostEntryPathOpenTradeProbability;
}

export interface StrategyParams {
    [key: string]: number;
}

export type TradeFilterMode = 'none' | 'close' | 'volume' | 'rsi' | 'trend' | 'adx';
export type TradeDirection = 'long' | 'short' | 'both' | 'combined';
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
    // Internal field for Rust engine and legacy config compatibility. Use tradeFilterMode.
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
    /** Run strategy logic on a global higher timeframe and map signals back to chart bars */
    strategyTimeframeEnabled?: boolean;
    /** Higher timeframe in minutes for global strategy execution */
    strategyTimeframeMinutes?: number;
    /** Capture indicator snapshots at trade entry for pattern analysis */
    captureSnapshots?: boolean;

    // ── Snapshot-based trade filters (stackable, AND logic) ──
    /** Minimum ATR% at entry (0 = disabled). Filters out low-volatility entries. */
    snapshotAtrPercentMin?: number;
    /** Maximum ATR% at entry (0 = disabled). Filters out high-volatility entries. */
    snapshotAtrPercentMax?: number;
    /** Minimum volume ratio at entry (0 = disabled). Filters out low-volume entries. */
    snapshotVolumeRatioMin?: number;
    /** Maximum volume ratio at entry (0 = disabled). Filters out volume spikes. */
    snapshotVolumeRatioMax?: number;
    /** Minimum ADX at entry (0 = disabled). Filters out range-bound entries. */
    snapshotAdxMin?: number;
    /** Maximum ADX at entry (0 = disabled). Filters out over-trending entries. */
    snapshotAdxMax?: number;
    /** Minimum EMA distance % (0 = disabled). Positive = above EMA. */
    snapshotEmaDistanceMin?: number;
    /** Maximum EMA distance % (0 = disabled). */
    snapshotEmaDistanceMax?: number;
    /** Min RSI at entry (0 = disabled) */
    snapshotRsiMin?: number;
    /** Max RSI at entry (0 = disabled) */
    snapshotRsiMax?: number;
    /** Min price range position (0-1, 0 = disabled) */
    snapshotPriceRangePosMin?: number;
    /** Max price range position (0-1, 0 = disabled) */
    snapshotPriceRangePosMax?: number;
    /** Max bars from recent high (0 = disabled) */
    snapshotBarsFromHighMax?: number;
    /** Max bars from recent low (0 = disabled) */
    snapshotBarsFromLowMax?: number;
    /** Minimum trend efficiency at entry (0 = disabled) */
    snapshotTrendEfficiencyMin?: number;
    /** Maximum trend efficiency at entry (0 = disabled) */
    snapshotTrendEfficiencyMax?: number;
    /** Minimum ATR regime ratio at entry (0 = disabled) */
    snapshotAtrRegimeRatioMin?: number;
    /** Maximum ATR regime ratio at entry (0 = disabled) */
    snapshotAtrRegimeRatioMax?: number;
    /** Minimum candle body percent at entry (0 = disabled) */
    snapshotBodyPercentMin?: number;
    /** Maximum candle body percent at entry (0 = disabled) */
    snapshotBodyPercentMax?: number;
    /** Minimum wick skew at entry (-100..100, 0 = disabled) */
    snapshotWickSkewMin?: number;
    /** Maximum wick skew at entry (-100..100, 0 = disabled) */
    snapshotWickSkewMax?: number;
    /** Minimum volume trend at entry (0 = disabled) */
    snapshotVolumeTrendMin?: number;
    /** Maximum volume trend at entry (0 = disabled) */
    snapshotVolumeTrendMax?: number;
    /** Minimum volume burst z-score at entry (0 = disabled) */
    snapshotVolumeBurstMin?: number;
    /** Maximum volume burst z-score at entry (0 = disabled) */
    snapshotVolumeBurstMax?: number;
    /** Minimum vol-price divergence at entry (0 = disabled, range -1..1) */
    snapshotVolumePriceDivergenceMin?: number;
    /** Maximum vol-price divergence at entry (0 = disabled, range -1..1) */
    snapshotVolumePriceDivergenceMax?: number;
    /** Minimum volume consistency at entry (0 = disabled) */
    snapshotVolumeConsistencyMin?: number;
    /** Maximum volume consistency at entry (0 = disabled) */
    snapshotVolumeConsistencyMax?: number;
    /** Min directional close location % (0-100, 0 = disabled) */
    snapshotCloseLocationMin?: number;
    /** Max directional close location % (0-100, 0 = disabled) */
    snapshotCloseLocationMax?: number;
    /** Min opposite wick % (0-100, 0 = disabled) */
    snapshotOppositeWickMin?: number;
    /** Max opposite wick % (0-100, 0 = disabled) */
    snapshotOppositeWickMax?: number;
    /** Min candle range/ATR multiple (0 = disabled) */
    snapshotRangeAtrMultipleMin?: number;
    /** Max candle range/ATR multiple (0 = disabled) */
    snapshotRangeAtrMultipleMax?: number;
    /** Min momentum consistency (0-100, 0 = disabled) */
    snapshotMomentumConsistencyMin?: number;
    /** Max momentum consistency (0-100, 0 = disabled) */
    snapshotMomentumConsistencyMax?: number;
    /** Min break-quality score (0-100, 0 = disabled) */
    snapshotBreakQualityMin?: number;
    /** Max break-quality score (0-100, 0 = disabled) */
    snapshotBreakQualityMax?: number;
    /** Min 60m directional performance % (0 = disabled) */
    snapshotTf60PerfMin?: number;
    /** Max 60m directional performance % (0 = disabled) */
    snapshotTf60PerfMax?: number;
    /** Min 90m directional performance % (0 = disabled) */
    snapshotTf90PerfMin?: number;
    /** Max 90m directional performance % (0 = disabled) */
    snapshotTf90PerfMax?: number;
    /** Min 120m directional performance % (0 = disabled) */
    snapshotTf120PerfMin?: number;
    /** Max 120m directional performance % (0 = disabled) */
    snapshotTf120PerfMax?: number;
    /** Min 480m directional performance % (0 = disabled) */
    snapshotTf480PerfMin?: number;
    /** Max 480m directional performance % (0 = disabled) */
    snapshotTf480PerfMax?: number;
    /** Min multi-timeframe confluence % (0 = disabled) */
    snapshotTfConfluencePerfMin?: number;
    /** Max multi-timeframe confluence % (0 = disabled) */
    snapshotTfConfluencePerfMax?: number;
    /** Min composite entry-quality score (0-100, 0 = disabled) */
    snapshotEntryQualityScoreMin?: number;
    /** Max composite entry-quality score (0-100, 0 = disabled) */
    snapshotEntryQualityScoreMax?: number;
}

export interface Signal {
    time: Time;
    type: 'buy' | 'sell';
    price: number;
    /** Raw trigger level before execution shift/slippage (used by quality filters) */
    triggerPrice?: number;
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
