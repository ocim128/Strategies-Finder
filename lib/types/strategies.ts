import type { Time } from "lightweight-charts";
import type { BacktestPolymarketTradeSummary, TradePolymarketOutcome } from "./polymarket-outcomes";
import type { PolymarketExitMode } from "../polymarket-exit-mode";
import type { PolymarketEntrySelectionMode } from "../polymarket-entry-selection-mode";
import type { PolymarketOutcomeInterval } from "../polymarket-outcome-interval";
import type { BinanceMarketType } from "../binance-market";
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
    exitReason?: 'signal' | 'stop_loss' | 'take_profit' | 'trailing_stop' | 'time_stop' | 'partial' | 'probation_fail' | 'end_of_data' | 'polymarket_take_profit' | 'polymarket_stop_loss' | 'path_exit';
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
    binanceMarketType?: BinanceMarketType;
    candleCount: number;
    firstCandleTime: Time | null;
    lastCandleTime: Time | null;
}

export interface BacktestDiagnosticsTimings {
    total: number;
    dataClean: number;
    indicatorResolution: number;
    signalPreparation: number;
    signalIndexing: number;
    entryEvaluation: number;
    tradeSimulation: number;
    forcedClose: number;
    drawdown: number;
    metrics: number;
}

export interface BacktestDiagnosticsCounts {
    inputBars: number;
    evaluationBars: number;
    inputSignals: number;
    preparedSignals: number;
    barsScanned: number;
    barsWithPosition: number;
    entriesAttempted: number;
    tradesOpened: number;
    tradesClosed: number;
    signalExitOrders: number;
    forcedEndOfDataExits: number;
    fastPathRuns: number;
    maxOpenPositions: number;
}

export interface BacktestDiagnostics {
    counts: BacktestDiagnosticsCounts;
    timingsMs: BacktestDiagnosticsTimings;
    fastPath?: {
        used: boolean;
        blockers: string[];
        signalPreparation?: "indexed" | "objects";
    };
}

export interface BacktestExitControlDiagnostics {
    requestedDisableSignalExits: boolean;
    resolvedDisableSignalExits: boolean;
    exitStrategyOverrideEnabled: boolean;
    exitStrategyKey: string;
    primarySignals: number;
    exitOverrideSignals: number;
    mergedSignals: number;
    mergedExitOnlySignals: number;
    exitStrategyLoaded: boolean;
    skippedReason?: string;
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
    diagnostics?: BacktestDiagnostics;
    exitControlDiagnostics?: BacktestExitControlDiagnostics;
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

export type TradeDirection = 'long' | 'short' | 'both' | 'both_no_flip' | 'combined';
export type ExecutionModel = 'signal_close' | 'next_open' | 'next_close';
export type ConfirmationMode = 'agree' | 'disagree' | 'veto_opposite' | 'confirm_within_window' | 'veto_within_window';
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

export type PathExitMode =
    | 'off'
    | 'mfe_giveback'
    | 'momentum_deceleration'
    | 'capitulation_exhaustion'
    | 'squeeze_pressure'
    | 'conditional_hazard'
    | 'triple_barrier_meta'
    | 'structure_reclaim'
    | 'profit_compression';

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
    /** Minimum bars held before strategy signal exits and time-stop exits can close a trade. */
    riskMinHoldBars?: number;
    /** Enable the minimum hold-bars guard. */
    riskMinHoldEnabled?: boolean;
    /** Hard cap on bars held when risk management is active */
    riskMaxHoldBars?: number;
    /** Enable max hold bars cap */
    riskMaxHoldEnabled?: boolean;
    /** Block new entries for N bars after any trade closes. */
    riskCooldownBars?: number;
    /** Enable the post-exit entry cooldown. */
    riskCooldownEnabled?: boolean;
    /** Enable the win-streak stop loss override in percentage mode */
    riskWinStreakStopLossEnabled?: boolean;
    /** After N consecutive winning trades, new entries switch to the override stop loss % */
    riskWinStreakStopLossAfterWins?: number;
    /** Override stop loss % applied after the configured win streak. 0 disables the feature. */
    riskWinStreakStopLossPercent?: number;
    /** Ignore opposite strategy signals as exits when chart TP or SL risk exits are active. */
    disableSignalExits?: boolean;
    /** Enable Exit Strategy Override. Only effective when disableSignalExits is true. */
    exitStrategyOverrideEnabled?: boolean;
    /** Registry key of the strategy whose signals act as close-only exits under override. */
    exitStrategyKey?: string;
    /** Params for the exit strategy referenced by exitStrategyKey. */
    exitStrategyParams?: Record<string, number>;

    pathExitEnabled?: boolean;
    pathExitMode?: PathExitMode;
    pathExitMinBars?: number;
    pathExitMinMfePercent?: number;
    pathExitGivebackPercent?: number;
    pathExitLookbackBars?: number;
    pathExitThreshold?: number;
    pathExitMinSamples?: number;
    pathExitHorizonBars?: number;

    trendEmaPeriod?: number;
    trendEmaSlopeBars?: number;
    atrPercentMin?: number;
    atrPercentMax?: number;
    adxPeriod?: number;
    adxMin?: number;
    adxMax?: number;

    /** UI toggle for optional secondary confirmation strategies. */
    confirmationStrategiesToggle?: boolean;
    /** Optional secondary confirmation strategies. */
    confirmationStrategies?: string[];
    /** How selected confirmation strategies should interact with base entry signals. */
    confirmationMode?: ConfirmationMode;
    /** Symmetric chart-bar radius used by windowed confirmation modes. */
    confirmationWindowBars?: number;
    /** Optional params keyed by confirmation strategy id. */
    confirmationStrategyParams?: Record<string, StrategyParams>;
    marketMode?: MarketMode;
    tradeDirection?: TradeDirection;
    /** Invert strategy output by swapping buy/sell signals before execution handling */
    invertSignals?: boolean;
    /** Execution timing model for signal fills */
    executionModel?: ExecutionModel;
    /** Allow exits on the same bar as entry */
    allowSameBarExit?: boolean;
    /** Slippage in basis points (bps) applied to entry/exit fills */
    slippageBps?: number;
    /** Maximum concurrent open positions (1 = classic single-position, >1 = unlimited overlap). Default 1. */
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
    /** Delay Polymarket 1s CLOB entry pricing by N chart bars after the chart entry. */
    polymarketEntryDelayBars?: number;
    /** Skip Polymarket entries priced at or below N cents, or at or above 100-N cents. 0 disables. */
    polymarketEntryPriceFilterCents?: number;
    /** Backtest-only Polymarket adverse slippage in cents. Entries pay more and modeled exits receive less. */
    polymarketBacktestSlippageCents?: number;
    /** Enable skipping Polymarket entries near event close. */
    polymarketEntryCutoffEnabled?: boolean;
    /** Skip Polymarket entries inside the final N seconds of the event when cutoff is enabled. */
    polymarketEntryCutoffSeconds?: number;
    /** Polymarket exit evaluation mode. Same-event modes exit from cached Polymarket quotes before native resolution. */
    polymarketExitMode?: PolymarketExitMode;
    /** In same-event Polymarket exit modes, score every eligible chart trade in the event instead of one trade per Polymarket event. */
    polymarketSignalExitAllowMultipleTradesPerEvent?: boolean;
    /** Enable post-chart-entry Polymarket limit-entry fill simulation for supported annotated runs. */
    polymarketPostSignalLimitEntryEnabled?: boolean;
    /** Limit-entry pricing mode: fixed cents, first quote minus offset, or stale signal-time quote. */
    polymarketPostSignalLimitEntryMode?: "fixed_price" | "signal_offset" | "stale_signal_price";
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
    /** Backtest/live Polymarket side-price take-profit trigger. */
    polymarketProtectionTakeProfitEnabled?: boolean;
    /** Side-price cents above Polymarket entry used for the take-profit trigger. */
    polymarketProtectionTakeProfitCents?: number;
    /** Backtest/live Polymarket side-price stop-loss trigger. */
    polymarketProtectionStopLossEnabled?: boolean;
    /** Side-price cents below Polymarket entry used for the stop-loss trigger. */
    polymarketProtectionStopLossCents?: number;
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
    /**
     * Marks this signal as close-only: it may close an opposite-direction position
     * even when `disableSignalExits` is on, and will never open a new position.
     * Used by the Exit Strategy Override feature to inject a second strategy's
     * signals as pure exits.
     */
    exitOnly?: boolean;
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

export interface Polymarket1sQuoteContextRow {
    series_id: string;
    symbol: string;
    outcome_interval: string;
    event_start_ts: number;
    event_end_ts: number;
    sample_ts: number;
    yes_ask?: number | null;
    yes_mid: number | null;
    no_ask?: number | null;
    no_mid: number | null;
}

export interface Polymarket1sGammaContextRow {
    series_id: string;
    symbol: string;
    outcome_interval: string;
    event_start_ts: number;
    event_end_ts: number;
    snapshot_ts: number;
    gamma_yes_price: number | null;
    gamma_no_price: number | null;
}

export interface Polymarket1sRuntimeContext {
    symbol: string;
    outcomeSymbol: string;
    seriesId: string;
    outcomeInterval: PolymarketOutcomeInterval;
    quotes: readonly Polymarket1sQuoteContextRow[];
    gammaSnapshots?: readonly Polymarket1sGammaContextRow[];
}

export interface Polymarket1sConfig {
    required?: boolean;
}

/** Execution context bag passed as an optional argument to strategy methods. */
export interface StrategyExecutionContext {
    crossSymbol?: CrossSymbolRuntimeContext;
    polymarket1s?: Polymarket1sRuntimeContext;
}

export interface Strategy {
    name: string;
    description: string;
    defaultParams: StrategyParams;
    paramLabels: { [key: string]: string };
    /** Parameters that remain visible/available to execution but must not be searched by Finder. */
    finderFixedParams?: readonly string[];
    /** Optional parameter sanitizer used before execution/optimization. */
    normalizeParams?: (params: StrategyParams) => StrategyParams;
    /** Optional cross-symbol configuration. When present, the runtime will provide secondary data via execution context. */
    crossSymbolConfig?: CrossSymbolConfig;
    /** Optional 1s Polymarket context requirement for strategies using CLOB/Gamma signal-quality helpers. */
    polymarket1sConfig?: Polymarket1sConfig;
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
