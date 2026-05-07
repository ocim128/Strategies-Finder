import type { Time } from "lightweight-charts";
import type { BacktestPolymarketTradeSummary, TradePolymarketOutcome } from "./polymarket-outcomes";
import type { PolymarketEntrySelectionMode } from "../polymarket-entry-selection-mode";
import type { PolymarketOutcomeInterval } from "../polymarket-outcome-interval";
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
    /** Stop-loss price level for the active position targets when available */
    stopLossPrice?: number | null;
    /** Take-profit price level for the active position targets when available */
    takeProfitPrice?: number | null;
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
    tradeTimingQuality?: TradeTimingQuality;
    edgeStatistics?: import('../strategies/backtest/edge-statistics').EdgeStatistics;
    polymarketTradeSummary?: BacktestPolymarketTradeSummary;
    marketContext?: BacktestResultMarketContext;
}

export interface TradeTimingEntryHorizon {
    bars: number;
    score: number | null;
    avgMfePct: number | null;
    avgMaePct: number | null;
    positiveForwardRatePct: number | null;
    movementFloorPct: number | null;
    movementConfidencePct: number | null;
    sampleSize: number;
}

export interface TradeTimingExitHorizon {
    bars: number;
    score: number | null;
    avgAvoidedAdversePct: number | null;
    avgMissedContinuationPct: number | null;
    adverseAfterExitRatePct: number | null;
    movementFloorPct: number | null;
    movementConfidencePct: number | null;
    sampleSize: number;
}

export interface TradeTimingQuality {
    entryScore: number | null;
    exitScore: number | null;
    entry: {
        horizons: TradeTimingEntryHorizon[];
    };
    exit: {
        horizons: TradeTimingExitHorizon[];
        captureScore: number | null;
        averageGivebackPct: number | null;
        captureSampleSize: number;
    };
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
    /** Run strategy logic on a global higher timeframe and map signals back to chart bars */
    strategyTimeframeEnabled?: boolean;
    /** Higher timeframe in minutes for global strategy execution */
    strategyTimeframeMinutes?: number;
    /** Enable Polymarket outcome annotation for supported symbols. */
    polymarketAnnotationEnabled?: boolean;
    /** Optional Polymarket outcome series override. Blank means use the chart symbol. */
    polymarketOutcomeSymbol?: string;
    /** Native Polymarket outcome session. */
    polymarketOutcomeInterval?: PolymarketOutcomeInterval;
    /** Entry selection mode for 1m -> 5m Polymarket bridge scoring. */
    polymarketEntrySelectionMode?: PolymarketEntrySelectionMode;
    /** Entry offset minute (0..4) for fixed-offset 1m -> 5m Polymarket bridge scoring */
    polymarketEntryOffset?: number;
    /** Polymarket exit evaluation mode: resolve_hold scores at final binary outcome, signal_exit_same_event exits on chart sell signal inside the mapped native outcome session */
    polymarketExitMode?: "resolve_hold" | "signal_exit_same_event";
    /** Enable post-chart-entry Polymarket limit-entry fill simulation for supported annotated runs. */
    polymarketPostSignalLimitEntryEnabled?: boolean;
    /** Limit-entry pricing mode: fixed cents or first quote minus offset. */
    polymarketPostSignalLimitEntryMode?: "fixed_price" | "signal_offset";
    /** Limit-entry side price in cents, clamped to 1..99. */
    polymarketPostSignalLimitEntryPriceCents?: number;
    /** Limit-entry discount from the first side quote, in cents. */
    polymarketPostSignalLimitEntryOffsetCents?: number;
    /** Enable optional Polymarket target exit after a limit entry fills. */
    polymarketPostSignalLimitExitEnabled?: boolean;
    /** Target-exit pricing mode: fixed cents or filled entry plus offset. */
    polymarketPostSignalLimitExitMode?: "fixed_price" | "entry_offset";
    /** Fixed target-exit side price in cents, clamped to 1..99. */
    polymarketPostSignalLimitExitPriceCents?: number;
    /** Target-exit offset above the filled entry price, in cents. */
    polymarketPostSignalLimitExitOffsetCents?: number;
    /** Resolved secondary symbol for cross-symbol strategies. */
    crossSymbolSecondary?: string;
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

// ============================================================================
// Cross-Symbol Strategy Types
// ============================================================================

/** Static configuration declaring that a strategy requires a secondary symbol. */
export interface CrossSymbolConfig {
    /** Default secondary symbol when no override is provided. */
    defaultSymbol: string;
    /** Whether the user may override the secondary symbol in the UI. */
    userSelectable?: boolean;
    /** Minimum aligned bars required after trimming. Defaults to 50. */
    minBars?: number;
}

/** Runtime-resolved cross-symbol data passed to strategy execution methods. */
export interface CrossSymbolRuntimeContext {
    primarySymbol: string;
    secondarySymbol: string;
    secondaryData: OHLCVData[];
    alignedLength: number;
    trimmedLeadingBars: number;
}

/** Execution context bag passed as an optional argument to strategy methods. */
export interface StrategyExecutionContext {
    crossSymbol?: CrossSymbolRuntimeContext;
}

export interface Strategy {
    name: string;
    description: string;
    defaultParams: StrategyParams;
    paramLabels: { [key: string]: string };
    /** Optional parameter sanitizer used before execution/optimization. */
    normalizeParams?: (params: StrategyParams) => StrategyParams;
    /** Optional cross-symbol configuration. When present, the runtime will provide secondary data via execution context. */
    crossSymbolConfig?: CrossSymbolConfig;
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => Signal[];
    /**
     * Optional Finder/optimizer precompute seam for reusing dataset-derived state
     * across many candidate evaluations on the same bars/settings.
     */
    prepareFinderData?: (data: OHLCVData[], settings?: BacktestSettings, context?: StrategyExecutionContext) => unknown;
    /**
     * Optional execute variant that consumes data produced by prepareFinderData.
     * The original OHLCV array is still provided so strategies can opt in gradually.
     */
    executePrepared?: (preparedData: unknown, params: StrategyParams, data: OHLCVData[], context?: StrategyExecutionContext) => Signal[];
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
