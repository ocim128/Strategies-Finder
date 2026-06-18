import type { BacktestDiagnosticsCounts, BacktestDiagnosticsTimings, BacktestResult, StrategyParams, Time } from "../types/strategies";
import type { PolymarketEvalResult } from "../types/polymarket-outcomes";
import type { PolymarketExitMode } from "../polymarket-exit-mode";

export type FinderMode = 'default' | 'grid' | 'random' | 'genetic';
export type PolymarketFinderRankMode = 'balanced' | 'accuracy' | 'accuracyTrades' | 'volume' | 'expectancy' | 'expectancyTrades' | 'profitFactor' | 'profitFactorTrades' | 'sizedNet';
export type FinderScope = 'current_chart' | 'symbol_universe';
export type FinderDataSlice = 'all' | '1' | '2' | '3' | '4' | '5';
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
    | 'profitableActiveRatio'
    | 'activeSymbols'
    | 'medianExpectancy'
    | 'medianSharpe'
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
    /** Raw backtest result (includes any final forced liquidation). */
    result: BacktestResult;
    /** Selection result with endpoint-bias trades removed. */
    selectionResult: BacktestResult;
    /** Composite edge ratio used for Finder-side quality ranking. */
    compositeEdgeRatio?: number;
    endpointAdjusted: boolean;
    endpointRemovedTrades: number;
    polymarketEval?: PolymarketEvalResult;
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
    medianNetProfit: number;
    worstNetProfit: number;
    bestNetProfit: number;
    evaluationStoppedEarly?: boolean;
    stoppedReason?: FinderUniverseEarlyStopReason;
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

export interface AssetLeadershipObservation {
    symbol: string;
    assetA: string;
    assetB: string;
    status: FinderUniverseSymbolStatus;
    candidateRank: number;
    strategyKey: string;
    strategyName: string;
    interval: string;
    runId: string;
    runTimestamp: number;
    netProfit: number;
    expectancy: number;
    sharpeRatio: number;
    profitFactor: number;
    totalTrades: number;
    profitableActiveRatio: number;
    activeSymbols: number;
    totalUniverseTrades: number;
    topDecile: boolean;
    profitable: boolean;
    closeChangePercent?: number;
    directionalLookbackBars?: number;
}

export interface AssetLeadershipPersistedRun {
    runId: string;
    createdAt: number;
    interval: string;
    strategyPreset?: "follow" | "reversion" | "custom";
    strategyCount: number;
    universeSymbolCount: number;
    topN: number;
    candidates: FinderUniverseCandidate[];
}

export interface AssetLeadershipAssetRow {
    asset: string;
    score: number;
    directionalScore: number;
    directionalAppearances: number;
    avgPairChangePercent: number;
    previousScore: number;
    scoreChange: number;
    trend: "up" | "down" | "flat";
    appearances: number;
    profitableAppearances: number;
    topDecileAppearances: number;
    profitableRate: number;
    topDecileRate: number;
    avgSharpe: number;
    avgExpectancy: number;
    avgNetProfit: number;
    avgProfitFactor: number;
    avgRank: number;
    consistencyScore: number;
    persistenceScore: number;
    partnerDiversity: number;
    strongestPartner: string | null;
    strongestPartnerAppearances: number;
    latestRunScore: number;
    previousWindowScore: number;
    recentSlope: number;
    consecutiveRuns: number;
    totalRunsSeen: number;
    firstSeenAt: number;
    lastSeenAt: number;
}

export interface AssetLeadershipOverview {
    totalRuns: number;
    totalObservations: number;
    totalAssets: number;
    latestRunAt: number | null;
    recentWindowRuns: number;
    previousWindowRuns: number;
    topDecileThresholdRank: number;
    currentLeader: string | null;
    dominantAssetShare: number;
}

export interface AssetLeadershipDerivedMetric {
    label: string;
    value: string;
    description: string;
}

export interface AssetLeadershipReport {
    overview: AssetLeadershipOverview;
    currentLeaders: AssetLeadershipAssetRow[];
    strongestNow: AssetLeadershipAssetRow[];
    weakestNow: AssetLeadershipAssetRow[];
    emergingLeaders: AssetLeadershipAssetRow[];
    fallingLeaders: AssetLeadershipAssetRow[];
    consistentLeaders: AssetLeadershipAssetRow[];
    derivedMetrics: AssetLeadershipDerivedMetric[];
    recentRuns: Array<{
        runId: string;
        createdAt: number;
        interval: string;
        strategyPreset?: "follow" | "reversion" | "custom";
        strategyCount: number;
        universeSymbolCount: number;
        topN: number;
    }>;
}
