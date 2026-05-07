import type { BacktestResult, StrategyParams, Time } from "../types/strategies";
import type { PolymarketEvalResult } from "../types/polymarket-outcomes";
import type { PolymarketExitMode } from "../polymarket-exit-mode";

export type FinderMode = 'default' | 'grid' | 'random' | 'genetic';
export type PolymarketFinderRankMode = 'balanced' | 'accuracy' | 'volume' | 'expectancy' | 'expectancyTrades' | 'profitFactor' | 'profitFactorTrades';
export type FinderScope = 'current_chart' | 'symbol_universe';
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
    | 'polyProfitFactorBalance';
export type FinderUniverseMetric =
    | 'profitableActiveRatio'
    | 'activeSymbols'
    | 'medianExpectancy'
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
    polymarketExitMode?: PolymarketExitMode;
    polymarketPostSignalLimitEntryEnabled?: boolean;
    polymarketPostSignalLimitEntryMode?: "fixed_price" | "signal_offset";
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
