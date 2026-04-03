import type { Time } from "lightweight-charts";
import type { BacktestPolymarketTradeSummary, TradePolymarketOutcome } from "./polymarket-outcomes";
export type { Time };
export type { EdgeStatistics, EdgeRatioHorizon, TTestResult, StreakAnalysis } from '../strategies/backtest/edge-statistics';

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
    exitReason?: 'signal' | 'stop_loss' | 'take_profit' | 'trailing_stop' | 'time_stop' | 'partial' | 'probation_fail' | 'end_of_data';
    /** Entry mode: 'normal' for standard entries, 'warm_up' for queued pending entries */
    entryMode?: 'normal' | 'warm_up';
    /** Stop-loss price level for the active position targets when available */
    stopLossPrice?: number | null;
    /** Take-profit price level for the active position targets when available */
    takeProfitPrice?: number | null;
    /** Indicator snapshot at entry for pattern analysis */
    entrySnapshot?: TradeSnapshot;
    /** Polymarket outcome scored against this trade's entry timestamp when available */
    polymarketOutcome?: TradePolymarketOutcome | null;
}

export interface BacktestResultMarketContext {
    symbol: string;
    interval: string;
    candleCount: number;
    firstCandleTime: Time | null;
    lastCandleTime: Time | null;
}

export interface AdvancedPerformanceAnalytics {
    sortinoRatio: number;
    calmarRatio: number;
    sterlingRatio: number;
    tailRatio: number;
    skewness: number;
    /** Excess kurtosis where a normal distribution is approximately 0. */
    kurtosis: number;
    /** 95% one-period Value at Risk as a positive percentage loss. */
    valueAtRisk95: number;
    /** 95% one-period Conditional Value at Risk as a positive percentage loss. */
    conditionalValueAtRisk95: number;
    /** Ulcer Index as a percentage drawdown severity score. */
    ulcerIndex: number;
    serenityIndex: number;
    /** Annualized compounded growth rate expressed in percent. */
    cagr: number;
    confidenceLevelPct: number;
    riskFreeRateAnnual: number;
    sampleCount: number;
}

export interface ExpectancyBreakdownRow {
    label: string;
    tradeCount: number;
    winRate: number;
    netProfit: number;
    expectancy: number;
    avgWin: number;
    avgLoss: number;
    profitFactor: number;
    avgEntryPrice?: number | null;
    breakEvenWinRate?: number | null;
    edgeVsBreakEven?: number | null;
}

export interface ExpectancyBreakdownSection {
    id: "side" | "session_minute" | "price_range_position";
    title: string;
    hint: string;
    rows: ExpectancyBreakdownRow[];
}

export interface BacktestExpectancyBreakdown {
    sections: ExpectancyBreakdownSection[];
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
    performanceAnalytics?: AdvancedPerformanceAnalytics;
    expectancyBreakdown?: BacktestExpectancyBreakdown;
    entryStats?: EntryStats;
    postEntryPath?: PostEntryPathStats;
    edgeStatistics?: import('../strategies/backtest/edge-statistics').EdgeStatistics;
    polymarketTradeSummary?: BacktestPolymarketTradeSummary;
    marketContext?: BacktestResultMarketContext;
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

/** Aggregated indicator average for a single snapshot metric */
export interface SnapshotProfileRow {
    key: string;
    label: string;
    winAvg: number | null;
    loseAvg: number | null;
    allAvg: number | null;
    delta: number | null;
    /** Absolute delta relative to the all-trades standard deviation (higher = more discriminating) */
    significance: number | null;
}

export interface SnapshotProfileStats {
    rows: SnapshotProfileRow[];
    winSampleSize: number;
    loseSampleSize: number;
}

/** Exit reason counts for a single reason category */
export interface ExitReasonRow {
    reason: string;
    winCount: number;
    winPct: number;
    loseCount: number;
    losePct: number;
    totalCount: number;
    totalPct: number;
}

export interface ExitReasonBreakdown {
    rows: ExitReasonRow[];
    totalWins: number;
    totalLosses: number;
}

export interface PostEntryPathStats {
    horizonBars: number[];
    win: PostEntryPathBucketStats;
    lose: PostEntryPathBucketStats;
    all: PostEntryPathBucketStats;
    openTradeProbability: PostEntryPathOpenTradeProbability;
    snapshotProfile?: SnapshotProfileStats;
    exitReasonBreakdown?: ExitReasonBreakdown;
}

export interface StrategyParams {
    [key: string]: number;
}

export type TradeFilterMode =
    | 'none'
    | 'close'
    | 'volume'
    | 'rsi'
    | 'trend'
    | 'adx'
    | 'htf_drift'
    | 'trend_htf_bias'
    | 'trend_exec_alignment';
export type TradeDirection = 'long' | 'short' | 'both' | 'both_flip_loss_2' | 'combined';
export type ExecutionModel = 'signal_close' | 'next_open' | 'next_close';
export type MarketMode = 'all' | 'uptrend' | 'downtrend' | 'sideway';
export type PercentageTakeProfitMode =
    | 'fixed'
    | 'mfe_bootstrap'
    | 'edge_weighted'
    | 'expectancy_optimal'
    | 'regime_calibrated'
    | 'information_coefficient'
    | 'path_efficiency'
    | 'serial_dependency'
    | 'minimum_surprisal';

export interface BacktestSettings {
    atrPeriod?: number;
    stopLossAtr?: number;
    takeProfitAtr?: number;
    trailingAtr?: number;
    partialTakeProfitAtR?: number;
    partialTakeProfitPercent?: number;
    breakEvenAtR?: number;
    /** When price moves this % in your favor, move stop to entry price. Works in percentage mode without requiring a stop loss. */
    breakEvenPercent?: number;
    timeStopBars?: number;

    // Risk management
    riskMode?: 'simple' | 'advanced' | 'percentage';
    stopLossPercent?: number;
    takeProfitPercent?: number;
    takeProfitMode?: PercentageTakeProfitMode;
    /** MFE-bootstrap TP: percentile of historical winning MFE distribution used as TP% (non-causal) */
    takeProfitMfeBootstrapPercentile?: number;
    /** Adaptive TP modes: rolling closed-trade lookback used for TP calibration. */
    takeProfitAdaptiveLookbackTrades?: number;
    /** Adaptive TP modes: recent sub-window used by serial/stability-sensitive modes. */
    takeProfitAdaptiveRecentWindow?: number;
    /** Adaptive TP modes: floor multiplier applied to Base Take Profit %. */
    takeProfitAdaptiveMinMultiplier?: number;
    /** Adaptive TP modes: ceiling multiplier applied to Base Take Profit %. */
    takeProfitAdaptiveMaxMultiplier?: number;
    /** Adaptive TP modes: number of TP candidates sampled between min/max multipliers. */
    takeProfitAdaptiveGridSteps?: number;
    /** Regime-calibrated TP: blend weight between global and regime-specific target. */
    takeProfitAdaptiveRegimeBlend?: number;
    /** Information-coefficient TP: scales how strongly IC widens/tightens the target. */
    takeProfitAdaptiveIcScale?: number;
    stopLossEnabled?: boolean;
    takeProfitEnabled?: boolean;
    /** Hard cap on bars held when risk management is active */
    riskMaxHoldBars?: number;
    /** Enable max hold bars cap */
    riskMaxHoldEnabled?: boolean;
    /** Enable the win-streak stop loss override in percentage mode */
    riskWinStreakStopLossEnabled?: boolean;
    /** After N consecutive winning trades, new entries switch to the override stop loss % */
    riskWinStreakStopLossAfterWins?: number;
    /** Override stop loss % applied after the configured win streak. 0 disables the feature. */
    riskWinStreakStopLossPercent?: number;

    trendEmaPeriod?: number;
    /** EMA period used by HTF bias filters (trend_htf_bias). */
    htfBiasEmaPeriod?: number;
    /** EMA period used by execution-side trend filters (trend_exec_alignment). */
    executionTrendEmaPeriod?: number;
    trendEmaSlopeBars?: number;
    atrPercentMin?: number;
    atrPercentMax?: number;
    adxPeriod?: number;
    adxMin?: number;
    adxMax?: number;

    tradeFilterMode?: TradeFilterMode;
    /** @deprecated Legacy key retained for backward compatibility when loading old configs */
    entryConfirmation?: string;
    /** @deprecated Legacy UI toggle retained for compatibility with persisted finder/scanner configs */
    entrySettingsToggle?: boolean;
    /** Optional secondary confirmation strategies (legacy combiner path). */
    confirmationStrategies?: string[];
    /** Optional params keyed by confirmation strategy id. */
    confirmationStrategyParams?: Record<string, StrategyParams>;
    confirmLookback?: number;
    volumeSmaPeriod?: number;
    volumeMultiplier?: number;
    rsiPeriod?: number;
    rsiBullish?: number;
    rsiBearish?: number;
    marketMode?: MarketMode;
    tradeDirection?: TradeDirection;
    /** Invert strategy output by swapping buy/sell signals before execution handling */
    invertSignals?: boolean;
    /** For both_flip_loss_2: flip side after this many consecutive losses on active side */
    flipAfterConsecutiveLosses?: number;
    /** For both_flip_loss_2: after a flip, block additional flips for this many closed trades */
    flipCooldownTrades?: number;
    /** For both_flip_loss_2: require at least this many closed trades before first flip is allowed */
    minTradesBeforeFirstFlip?: number;
    /** Execution timing model for signal fills */
    executionModel?: ExecutionModel;
    /** Allow exits on the same bar as entry */
    allowSameBarExit?: boolean;
    /** Slippage in basis points (bps) applied to entry/exit fills */
    slippageBps?: number;
    /** Maximum concurrent open positions (1 = classic single-position, 2 = allow overlap). Default 1. */
    maxOpenTrades?: number;
    /** Queue skipped signals and execute when a position closes on the next bar */
    warmUpEntryEnabled?: boolean;
    /** Run strategy logic on a global higher timeframe and map signals back to chart bars */
    strategyTimeframeEnabled?: boolean;
    /** Higher timeframe in minutes for global strategy execution */
    strategyTimeframeMinutes?: number;
    /** 2H close-hour parity mode for data alignment; `both` is compare-only orchestration mode */
    twoHourCloseParity?: 'odd' | 'even' | 'both';
    /** Capture indicator snapshots at trade entry for pattern analysis */
    captureSnapshots?: boolean;
    /** Enable Polymarket outcome annotation for supported symbols (BTCUSDT, ETHUSDT, etc on 5m) */
    polymarketAnnotationEnabled?: boolean;
    /** Entry offset minute (0..4) for 1m -> 5m Polymarket bridge scoring */
    polymarketEntryOffset?: number;

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
    /**
     * Optional exit size fraction (0..1] for signal-driven exits.
     * Omitted means full exit.
     */
    sizeFraction?: number;
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
    title?: string;
    summary?: EntryPreviewSummary;
    meta?: EntryPreviewMeta;
    rows?: EntryPreviewRow[];
    note?: string;
}

export interface EntryPreviewSummary {
    eyebrow?: string;
    headline: string;
    detail?: string;
    tone?: 'positive' | 'negative' | 'neutral' | 'waiting';
}

export interface EntryPreviewMeta {
    longReady?: boolean;
    shortReady?: boolean;
    nearestSide?: 'long' | 'short' | 'none';
    deadzoneActive?: boolean;
    secondsToClose?: number | null;
    isClosedBarPreview?: boolean;
    isStaleData?: boolean;
}

export interface EntryPreviewRow {
    label: string;
    value: string;
    section?: string;
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
    /** Optional parameter sanitizer used before execution/optimization. */
    normalizeParams?: (params: StrategyParams) => StrategyParams;
    execute: (data: OHLCVData[], params: StrategyParams) => Signal[];
    /**
     * Optional Finder/optimizer precompute seam for reusing dataset-derived state
     * across many candidate evaluations on the same bars/settings.
     */
    prepareFinderData?: (data: OHLCVData[], settings?: BacktestSettings) => unknown;
    /**
     * Optional execute variant that consumes data produced by prepareFinderData.
     * The original OHLCV array is still provided so strategies can opt in gradually.
     */
    executePrepared?: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => Signal[];
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
