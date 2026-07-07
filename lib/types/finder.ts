import type { BacktestDiagnosticsCounts, BacktestDiagnosticsTimings, BacktestResult, StrategyParams, Time } from "../types/strategies";
import type { PolymarketEvalResult } from "../types/polymarket-outcomes";
import type { PolymarketExitMode } from "../polymarket-exit-mode";

export type FinderMode = 'default' | 'grid' | 'random' | 'genetic';
export type PolymarketFinderRankMode = 'balanced' | 'accuracy' | 'accuracyTrades' | 'volume' | 'expectancy' | 'expectancyTrades' | 'profitFactor' | 'profitFactorTrades' | 'sizedNet';
export type FinderScope = 'current_chart' | 'symbol_universe';
export type FinderDataSlice = 'all' | '1' | '2' | '3' | '4' | '5' | 'half_oldest' | 'half_newest';
/**
 * Out-of-sample validation verdict for the complementary data window.
 * - `pass`: OOS net profit >= 0 AND profit factor >= 1.0
 * - `fail`: OOS evaluated with enough trades but degraded below the gate
 * - `inconclusive`: OOS produced fewer trades than the IS minTrades floor
 */
export type FinderOosVerdict = 'pass' | 'fail' | 'inconclusive';
export type FinderMetric =
    | 'netProfit'
    | 'profitFactor'
    | 'sharpeRatio'
    | 'netProfitPercent'
    | 'winRate'
    | 'maxDrawdownPercent'
    | 'expectancy'
    | 'compositeEdgeRatio'
    | 'entryScore'
    | 'exitScore'
    | 'averageGain'
    | 'totalTrades'
    | 'polyScore'
    | 'polyWins'
    | 'polyWinRate'
    | 'polyCoverage'
    | 'polyPredictions'
    | 'polyExpectancy'
    | 'polyExpectancyBalance'
    | 'polyProfitFactor'
    | 'polyProfitFactorBalance'
    | 'polySizedNet';
export type FinderUniverseMetric =
    | 'robustUniverseScore'
    | 'windowStabilityScore'
    | 'profitableActiveRatio'
    | 'activeSymbols'
    | 'medianExpectancy'
    | 'medianSharpe'
    | 'medianProfitFactor'
    | 'medianCompositeEdgeRatio'
    | 'worstNetProfit'
    | 'totalTrades';

export interface FinderUniverseOptions {
    symbols: string[];
    minActiveSymbols: number;
    minTotalTrades: number;
    minProfitableActiveRatio: number;
    sortPriority: FinderUniverseMetric[];
}

export interface FinderOptions {
    mode: FinderMode;
    sortPriority: FinderMetric[];
    useAdvancedSort: boolean;
    scope?: FinderScope;
    dataSlice?: FinderDataSlice;
    randomSeed?: number;
    multiTimeframeEnabled?: boolean;
    timeframes?: string[];
    topN: number;
    steps: number;
    rangePercent: number;
    maxRuns: number;
    tradeFilterEnabled: boolean;
    minTrades: number;
    maxTrades: number;
    freezeRiskManagement?: boolean;
    randomizePathExitParams?: boolean;
    comboEnabled?: boolean;
    comboPrimaryConfigName?: string;
    polymarketScoringEnabled?: boolean;
    polymarketRankMode?: PolymarketFinderRankMode;
    polymarketMinScoredPredictions?: number;
    polymarketLockOffset?: boolean;
    polymarketAfterTakeProfitOnly?: boolean;
    polymarketEntryDelayBars?: number;
    polymarketEntryPriceFilterCents?: number;
    polymarketBacktestSlippageCents?: number;
    polymarketExitMode?: PolymarketExitMode;
    polymarketSignalExitAllowMultipleTradesPerEvent?: boolean;
    polymarketPostSignalLimitEntryEnabled?: boolean;
    polymarketPostSignalLimitEntryMode?: "fixed_price" | "signal_offset" | "stale_signal_price";
    polymarketPostSignalLimitEntryPriceCents?: number;
    polymarketPostSignalLimitEntryOffsetCents?: number;
    polymarketPostSignalLimitExitEnabled?: boolean;
    polymarketPostSignalLimitExitMode?: "fixed_price" | "entry_offset";
    polymarketPostSignalLimitExitPriceCents?: number;
    polymarketPostSignalLimitExitOffsetCents?: number;
    /**
     * When true and disableSignalExits is on, Finder varies the exit-strategy's params
     * alongside the entry strategy's params and uses its signals as close-only exits.
     */
    exitStrategyOverrideEnabled?: boolean;
    /** Registry key of the strategy whose signals act as close-only exits. */
    exitStrategyKey?: string;
    /**
     * Exit strategy's default params, pre-resolved at Finder kickoff. Param-space
     * generation merges these with the entry strategy's params using an `_exit__` prefix.
     */
    exitStrategyBaseParams?: StrategyParams;
    /**
     * When true, after IS ranking the complementary half of the data window is
     * backtested for each top-N survivor and any that degrade are filtered out.
     * Honored for both current_chart and symbol_universe scopes; only effective
     * when dataSlice is half_oldest or half_newest, and inert under Polymarket
     * scoring (readOptions never sets it otherwise).
     */
    oosValidationEnabled?: boolean;
    universe?: FinderUniverseOptions;
}

export interface EndpointSelectionAdjustment {
    result: BacktestResult;
    adjusted: boolean;
    removedTrades: number;
}

export interface FinderResult {
    key: string;
    name: string;
    comboMode?: boolean;
    comboPrimaryConfigName?: string;
    timeframes?: string[];
    params: StrategyParams;
    exitStrategyKey?: string;
    exitStrategyParams?: StrategyParams;
    /** Raw backtest result (includes any final forced liquidation). */
    result: BacktestResult;
    /** Selection result with endpoint-bias trades removed. */
    selectionResult: BacktestResult;
    /** Composite edge ratio used for Finder-side quality ranking. */
    compositeEdgeRatio?: number;
    endpointAdjusted: boolean;
    endpointRemovedTrades: number;
    polymarketEval?: PolymarketEvalResult;
    /**
     * Out-of-sample backtest on the complementary data window. Present only when
     * OOS validation ran for this candidate. Used for the IS/OOS gate and the
     * OOS metric chip / verdict badge on the result row.
     */
    oosResult?: BacktestResult;
    /** OOS gate verdict. Present iff oosResult is present. */
    oosVerdict?: FinderOosVerdict;
}

export type FinderUniverseSymbolStatus =
    | 'profitable'
    | 'losing'
    | 'flat'
    | 'no_trades'
    | 'load_failed'
    | 'run_failed';

export type FinderUniverseEarlyStopReason =
    | 'unreachable_profitable_ratio'
    | 'unreachable_active_symbols'
    | 'unreachable_total_trades';

export interface FinderUniverseSymbolMetrics {
    netProfit: number;
    netProfitPercent: number;
    expectancy: number;
    avgTrade: number;
    winRate: number;
    profitFactor: number;
    totalTrades: number;
    maxDrawdownPercent: number;
    winningTrades: number;
    losingTrades: number;
    avgWin: number;
    avgLoss: number;
    sharpeRatio: number;
    /** True when Sharpe was actually computed; false means the fast universe path skipped it. */
    sharpeRatioAvailable?: boolean;
    /** True when drawdown was actually computed; false means the fast universe path skipped it. */
    drawdownAvailable?: boolean;
    /**
     * Composite Edge Ratio (avg MFE/MAE across horizons). Only populated when
     * the active Finder sort requests it, since it needs per-trade OHLCV lookups.
     * Undefined otherwise; treat as 0/missing when not requested.
     */
    compositeEdgeRatio?: number;
}

export interface FinderUniverseSymbolResult {
    symbol: string;
    status: FinderUniverseSymbolStatus;
    barCount: number;
    firstTime?: Time;
    lastTime?: Time;
    firstClose?: number;
    lastClose?: number;
    directionalLookbackClose?: number;
    directionalLookbackBars?: number;
    result?: FinderUniverseSymbolMetrics;
    error?: string;
    /**
     * Out-of-sample metrics on the complementary data window. Present only when
     * OOS validation ran for this symbol. Drives the per-symbol OOS badge.
     */
    oosResult?: FinderUniverseSymbolMetrics;
    /** Per-symbol OOS gate verdict. Present iff oosResult is present. */
    oosVerdict?: FinderOosVerdict;
}

/**
 * Strategy-level OOS summary attached to a FinderUniverseCandidate when OOS
 * validation ran. The verdict aggregates per-symbol OOS outcomes; the ratios
 * let the renderer show how much of the IS edge survived out-of-sample.
 */
export interface FinderUniverseOosAggregate {
    verdict: FinderOosVerdict;
    activeSymbols: number;
    profitableSymbols: number;
    profitableActiveRatio: number;
    worstNetProfit: number;
}

export interface FinderUniverseCandidate {
    strategyKey: string;
    strategyName: string;
    params: StrategyParams;
    symbols: FinderUniverseSymbolResult[];
    activeSymbols: number;
    profitableSymbols: number;
    losingSymbols: number;
    flatSymbols: number;
    noTradeSymbols: number;
    totalTrades: number;
    profitableActiveRatio: number;
    medianExpectancy: number;
    medianSharpe: number;
    /** True when medianSharpe is based on computed symbol Sharpe values. */
    medianSharpeAvailable: boolean;
    medianProfitFactor: number;
    medianNetProfit: number;
    worstNetProfit: number;
    bestNetProfit: number;
    /** Median per-symbol Composite Edge Ratio across active symbols (0 when never computed). */
    medianCompositeEdgeRatio: number;
    /** Bounded 0..100 score favoring broad, sufficiently sampled, downside-aware universe performance. */
    robustUniverseScore: number;
    /** Bounded 0..100 score comparing IS breadth against the OOS validation window; 0 until OOS validation runs. */
    windowStabilityScore: number;
    evaluationStoppedEarly?: boolean;
    stoppedReason?: FinderUniverseEarlyStopReason;
    /** Registry key of the sampled exit-strategy lib, when Exit Strategy Override is active. */
    exitStrategyKey?: string;
    /** Display name of the sampled exit-strategy lib, when Exit Strategy Override is active. */
    exitStrategyName?: string;
    /** Sampled exit-strategy params (prefix already stripped), when Exit Strategy Override is active. */
    exitStrategyParams?: StrategyParams;
    /**
     * Strategy-level OOS summary across all symbols. Present only when OOS
     * validation ran for this candidate. A `fail` verdict is filtered out of
     * the survivor list.
     */
    oosAggregate?: FinderUniverseOosAggregate;
}

export type FinderLatestResults =
    | { scope: 'current_chart'; results: FinderResult[] }
    | { scope: 'symbol_universe'; results: FinderUniverseCandidate[] };

export interface FinderRandomBenchmark {
    pipeline: 'standard' | 'rust_native' | 'ts_funnel' | 'rust_funnel';
    engineMode: string;
    totalRuns: number;
    processedRuns: number;
    prescreenRuns: number;
    shortlistRuns: number;
    fullRuns: number;
    shown: number;
    shortBars: number;
    shortCoverage: number;
    rustCandidateCount: number;
    runsPerSecond: number;
    msPerRun: number;
}

export interface FinderStrategyDiagnostics {
    key: string;
    name: string;
    runs: number;
    failedRuns: number;
    skippedRuns: number;
    zeroSignalRuns: number;
    avgSignalMs: number;
    avgBacktestMs: number;
    avgTotalMs: number;
    totalMs: number;
    runtimePct: number;
    usedPreparedData: boolean;
    backtest?: FinderBacktestDiagnostics;
    failureReasons?: FinderFailureReasonDiagnostics[];
}

export interface FinderBacktestDiagnostics {
    runs: number;
    avgInputSignals: number;
    avgPreparedSignals: number;
    avgBarsScanned: number;
    avgBarsWithPosition: number;
    avgEntriesAttempted: number;
    avgTradesOpened: number;
    avgTradesClosed: number;
    fastPathRuns: number;
    fastPathBlockers?: FinderFailureReasonDiagnostics[];
    maxOpenPositions: number;
    totals: BacktestDiagnosticsCounts;
    timingsMs: BacktestDiagnosticsTimings;
}

export interface FinderFailureReasonDiagnostics {
    reason: string;
    runs: number;
}

export interface FinderFailureDiagnostics extends FinderFailureReasonDiagnostics {
    strategyKeys: string[];
}

export interface FinderUniverseDiagnostics {
    totalSymbols: number;
    loadedSymbols: number;
    failedSymbols: Array<{
        symbol: string;
        reason: string;
    }>;
    dataWindow?: {
        dataSlice: FinderDataSlice;
        loadedBars: {
            min: number;
            max: number;
            avg: number;
        };
        slicedBars: {
            min: number;
            max: number;
            avg: number;
        };
        shortestSymbols: Array<{
            symbol: string;
            loadedBars: number;
            slicedBars: number;
            firstTime?: Time;
            lastTime?: Time;
            synthetic: boolean;
        }>;
    };
}

export interface FinderDiagnostics {
    runId: string;
    symbol: string;
    interval: string;
    mode: FinderMode;
    engineMode: string;
    data: {
        inputBars: number;
        evaluationBars: number;
        selectedStrategies: number;
        totalParamRuns: number;
        batchSize: number;
    };
    counts: {
        processedRuns: number;
        filteredRuns: number;
        shownResults: number;
        rustCompletedRuns: number;
        rustFallbackRuns: number;
        endpointAdjusted: number;
        failedRuns: number;
        skippedRuns: number;
    };
    timingsMs: {
        total: number;
        paramGeneration: number;
        dataLoading: number;
        pricePointLoading: number;
        closedDataSelection: number;
        indicatorPrecompute: number;
        preparedData: number;
        signalGeneration: number;
        backtest: number;
        polymarketEvaluation: number;
        rustRequest: number;
        resultEnrichment: number;
        resultRanking: number;
        reconciliation: number;
        uiUpdates: number;
        yielding: number;
    };
    timingPct: {
        paramGeneration: number;
        dataLoading: number;
        pricePointLoading: number;
        closedDataSelection: number;
        indicatorPrecompute: number;
        preparedData: number;
        signalGeneration: number;
        backtest: number;
        polymarketEvaluation: number;
        rustRequest: number;
        resultEnrichment: number;
        resultRanking: number;
        reconciliation: number;
        uiUpdates: number;
        yielding: number;
    };
    strategyBreakdown: FinderStrategyDiagnostics[];
    bottlenecks: string[];
    backtest?: FinderBacktestDiagnostics;
    failureBreakdown?: FinderFailureDiagnostics[];
    universe?: FinderUniverseDiagnostics;
}

