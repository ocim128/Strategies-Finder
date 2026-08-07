import type { BacktestDiagnosticsCounts, BacktestDiagnosticsTimings, BacktestResult, StrategyParams, Time } from "../types/strategies";
import type { PolymarketEvalResult } from "../types/polymarket-outcomes";
import type { PolymarketExitMode } from "../polymarket-exit-mode";

export type FinderMode = 'default' | 'grid' | 'random' | 'genetic';
export type PolymarketFinderRankMode = 'balanced' | 'accuracy' | 'accuracyTrades' | 'volume' | 'expectancy' | 'expectancyTrades' | 'profitFactor' | 'profitFactorTrades' | 'sizedNet';
/**
 * Finder execution scope.
 * - `current_chart`: search candidates for the current chart;
 * - `symbol_universe`: search candidates whose performance aggregates across the supplied symbols;
 * - `asset_opportunity`: search candidates independently per symbol, then rank symbols by
 *   current fresh-entry evidence.
 */
export type FinderScope = 'current_chart' | 'symbol_universe' | 'asset_opportunity';
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
    | 'medianExpectancyWeightedTrades'
    | 'medianSharpe'
    | 'medianProfitFactor'
    | 'medianProfitFactorWeightedTrades'
    | 'medianCompositeEdgeRatio'
    | 'worstMaxDrawdownPercent'
    | 'medianMaxDrawdownPercent'
    | 'medianReturnDrawdownRatio'
    | 'worstNetProfit'
    | 'totalTrades';

export interface FinderUniverseOptions {
    symbols: string[];
    minActiveSymbols: number;
    minTotalTrades: number;
    minProfitableActiveRatio: number;
    sortPriority: FinderUniverseMetric[];
}

/**
 * Asset Opportunity scope options. Drives the per-asset fresh-entry search.
 *
 * - `symbols`: asset list to search independently.
 * - `candidatePoolSize`: internal top-K historical candidate pool kept per asset
 *   before fresh-entry detection. The latest bar's signal can only promote a
 *   candidate inside this pool; the existing `topN` remains the number of final
 *   asset rows shown to the user.
 * - `minFreshSupport`: minimum number of same-direction fresh candidates within
 *   the pool required for a `select` grade.
 */
export interface FinderAssetOpportunityOptions {
    symbols: string[];
    candidatePoolSize: number;
    minFreshSupport: number;
    /** Number of historical bars reserved for fixed-horizon OOS measurement. */
    oosIgnoreLastBars?: number;
    /** Exactly three fixed forward-PnL horizons; defaults to 1, 3, 5. */
    oosHorizons?: number[];
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
    /**
     * Asset Opportunity scope options. Honored only when `scope === 'asset_opportunity'`.
     */
    assetOpportunity?: FinderAssetOpportunityOptions;
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
    /** Metrics are based on inversion-symmetric log returns for synthetic pairs. */
    metricBasis?: 'cash' | 'pair_neutral_log';
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
    /** True when the active Universe sort requested per-symbol drawdown computation. */
    drawdownMetricsAvailable: boolean;
    /** Largest max drawdown percentage across active symbols with computed drawdown. */
    worstMaxDrawdownPercent: number;
    /** Median max drawdown percentage across active symbols with computed drawdown. */
    medianMaxDrawdownPercent: number;
    /** Median per-symbol net-profit-percent / max-drawdown-percent ratio. */
    medianReturnDrawdownRatio: number;
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

/**
 * Fresh-entry status of the latest closed candle for one asset candidate.
 *
 * - `fresh`: a NEW entry transition occurred on the latest closed candle (the
 *   candidate was flat before and entered on the last bar; or reversed).
 * - `active`: the candidate is in a position whose entry happened on an earlier
 *   bar (a repeated state signal). Not a fresh opportunity.
 * - `flat`: no position is open and no new entry fired on the latest bar.
 *
 * The fresh-entry detector re-runs the strategy on the full closed data
 * (including the application candle) and inspects the latest trade + signal.
 */
export type FinderAssetFreshStatus = 'fresh' | 'active' | 'flat';

/**
 * Modeled entry timing of the fresh signal. Mirrors the backtest execution model.
 */
export type FinderAssetFillTiming = 'signal_close' | 'next_open' | 'next_close';

/**
 * Direction of the fresh/active entry, derived from the latest executed trade.
 */
export type FinderAssetDirection = 'long' | 'short';

/**
 * Top-K support counts within the per-asset historical candidate pool. These
 * describe the sampled top-K parameter pool; they are NOT claims about the
 * full strategy parameter space.
 */
export interface FinderAssetSupportCounts {
    /** Fresh long candidates within the pool (latest bar produced a long entry). */
    freshLongCandidates: number;
    /** Fresh short candidates within the pool (latest bar produced a short entry). */
    freshShortCandidates: number;
    /** Fresh candidates whose direction matches the winner's direction. */
    freshSameDirection: number;
    /** Total candidates carried in the historical pool (=== candidatePoolSize at most). */
    poolSize: number;
    /** Best (lowest) historical rank among fresh candidates in the pool. 1-based. */
    bestFreshRank: number | null;
    /** freshSameDirection / max(1, freshLongCandidates + freshShortCandidates). */
    directionAgreementRatio: number;
}

/**
 * Decision grade for one asset opportunity. An evidence grade, not a probability
 * that the next trade will win.
 *
 * - `reject`: fresh entry exists but historical expectancy is negative or fewer
 *   than the configured minimum historical trades.
 * - `watch`: fresh entry and positive historical expectancy, but insufficient
 *   same-direction top-K support or OOS is inconclusive.
 * - `select`: fresh entry, minimum historical trades met, positive historical
 *   expectancy, same-direction support at least `minFreshSupport`, and OOS pass
 *   when OOS validation is enabled.
 */
export type FinderAssetDecisionGrade = 'select' | 'watch' | 'reject';

/**
 * One asset opportunity result. Built independently per asset — no value is
 * averaged across assets. Every displayed row has a fresh entry; assets with
 * no fresh latest-bar transition are excluded from results and counted only
 * in diagnostics.
 *
 * The current signal is never used to choose the historical candidate rank; it
 * is only evaluated after historical ranking.
 */
export interface FinderAssetOpportunityResult {
    symbol: string;
    strategyKey: string;
    strategyName: string;
    /** Winning candidate parameters (entry params; exit params split when override is on). */
    params: StrategyParams;
    /** Registry key of the sampled exit-strategy lib, when Exit Strategy Override is active. */
    exitStrategyKey?: string;
    /** Display name of the sampled exit-strategy lib, when Exit Strategy Override is active. */
    exitStrategyName?: string;
    /** Sampled exit-strategy params (prefix already stripped), when Exit Strategy Override is active. */
    exitStrategyParams?: StrategyParams;
    /** Historical candidate rank inside the per-asset pool (1-based; 1 is best). */
    historicalRank: number;
    /** Total historical candidates evaluated by the random search for this asset. */
    totalCandidatesEvaluated: number;
    /** True when the winner is the historically-best candidate in the pool. */
    isHistoricalBest: boolean;
    freshStatus: FinderAssetFreshStatus;
    direction: FinderAssetDirection;
    /** Latest closed-candle signal time (unix seconds). Null when no signal exists. */
    latestSignalTime: Time | null;
    /** Signal age in bars, relative to the latest closed candle. 0 = fresh on the latest bar. */
    signalAgeBars: number;
    fillTiming: FinderAssetFillTiming;
    /** Historical selection metrics (endpoint-adjusted). */
    selectionResult: BacktestResult;
    /** OOS metrics on the complementary window, when OOS validation is enabled. */
    oosResult?: BacktestResult;
    /** OOS gate verdict. Present iff oosResult is present. */
    oosVerdict?: FinderOosVerdict;
    /** Fixed-horizon forward PnL measured inside the reserved OOS holdout. */
    oosHorizonMetrics?: import('../finder/finder-asset-opportunity-oos').FinderAssetOosMetrics;
    support: FinderAssetSupportCounts;
    grade: FinderAssetDecisionGrade;
}

export type FinderLatestResults =
    | { scope: 'current_chart'; results: FinderResult[] }
    | { scope: 'symbol_universe'; results: FinderUniverseCandidate[] }
    | { scope: 'asset_opportunity'; results: FinderAssetOpportunityResult[] };

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
    /** Candidate plans are strategy/parameter combinations, before symbols fan out. */
    candidatePlans?: number;
    /** Explicit Universe evaluation counts; avoids treating symbol evaluations as parameter runs. */
    symbolEvaluations?: {
        planned: number;
        completed: number;
        avoided: number;
        passingCandidates: number;
    };
    /** Server-job cache shared by every selected strategy in one Universe run. */
    jobDatasetCache?: {
        requests: number;
        hits: number;
        misses: number;
        successfulLoads: number;
        failedLoads: number;
        entries: number;
        uniqueBarsLoaded: number;
        slowestLoads?: Array<{
            symbol: string;
            interval: string;
            ms: number;
            bars: number;
        }>;
    };
    earlyStops?: {
        candidates: number;
        avoidedEvaluations: number;
        reasons: Array<{
            reason: string;
            candidates: number;
            avoidedEvaluations: number;
        }>;
    };
    /** Actual executor results, independent of the requested engine preference. */
    engineUsage?: {
        rustRequested: boolean;
        rustCompletedRuns: number;
        typescriptCompletedRuns: number;
        typescriptReasons: Array<{
            reason: string;
            runs: number;
        }>;
    };
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
        typescriptCompletedRuns?: number;
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
    /**
     * Asset Opportunity scope diagnostics. Tracks per-asset outcome counts and
     * per-asset load/run failures. Independent of the `universe` diagnostics.
     */
    assetOpportunity?: FinderAssetOpportunityDiagnostics;
}

/**
 * Diagnostics for one Asset Opportunity run. Reports per-asset outcomes and
 * failures so the user can see how many assets had no fresh entry, were
 * rejected, or failed to load.
 */
export interface FinderAssetOpportunityDiagnostics {
    totalAssets: number;
    /** Assets that produced at least one fresh candidate. */
    assetsWithFreshEntry: number;
    /** Assets that loaded and searched but had no fresh candidate. */
    assetsWithNoFreshEntry: number;
    /** Assets that produced at least one `select` grade. */
    selectGradeAssets: number;
    /** Assets that produced at least one `watch` grade. */
    watchGradeAssets: number;
    /** Assets whose best fresh candidate was rejected. */
    rejectGradeAssets: number;
    failedAssets: Array<{
        symbol: string;
        reason: string;
    }>;
    /** Aggregate work counts from the historical, fresh-entry, and OOS passes. */
    work?: {
        selectedStrategies: number;
        candidateEvaluationsEstimated: number;
        candidateEvaluationsAttempted: number;
        candidateEvaluationsCompleted: number;
        candidateEvaluationFailures: number;
        freshEntryRechecks: number;
        oosEvaluations: number;
        winnerAnalyticsRecomputations: number;
        loadedBars: {
            min: number;
            max: number;
            avg: number;
        };
    };
    /** Wall-clock phase timings. These identify where an optimization can pay off. */
    timingsMs?: {
        total: number;
        dataLoading: number;
        dataPreparation: number;
        inSampleSearch: number;
        parameterGeneration: number;
        candidateBacktests: number;
        freshEntryRechecks: number;
        oosValidation: number;
        resultReduction: number;
        winnerAnalytics: number;
        yielding: number;
        other: number;
    };
    /** Top 10 per-strategy totals, sorted by duration descending. */
    strategyBreakdown?: Array<{
        strategyKey: string;
        assetsEvaluated: number;
        candidatesEvaluated: number;
        candidateEvaluationsAttempted: number;
        candidateEvaluationsCompleted: number;
        candidateEvaluationFailures: number;
        freshEntryRechecks: number;
        oosEvaluations: number;
        durationMs: number;
    }>;
    /** The slowest asset/strategy passes, retained for actionable diagnosis. */
    slowestAssets?: Array<{
        symbol: string;
        strategyKey: string;
        dataBars: number;
        historicalBars: number;
        slicedHistoricalBars: number;
        oosBars: number;
        dataLoadingMs: number;
        candidatesEvaluated: number;
        freshEntryRechecks: number;
        oosEvaluations: number;
        timingsMs: {
            total: number;
            preparation: number;
            inSampleSearch: number;
            parameterGeneration: number;
            candidateBacktests: number;
            yielding: number;
            freshEntryRechecks: number;
            oosValidation: number;
            resultReduction: number;
            winnerAnalytics: number;
        };
    }>;
    /** Actual executor results, independent of the requested engine preference. */
    engineUsage?: {
        rustRequested: boolean;
        rustAttemptedRuns?: number;
        rustCompletedRuns: number;
        rustFallbackRuns?: number;
        typescriptCompletedRuns: number;
        typescriptReasons?: Array<{
            reason: string;
            runs: number;
        }>;
    };
}

