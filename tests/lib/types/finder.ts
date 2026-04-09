import type { BacktestResult, StrategyParams } from "../types/strategies";
import type { PolymarketEvalResult } from "../types/polymarket-outcomes";

export type FinderMode = 'default' | 'grid' | 'random' | 'genetic';
export type PolymarketFinderRankMode = 'balanced' | 'accuracy' | 'volume' | 'expectancy' | 'expectancyTrades' | 'profitFactor' | 'profitFactorTrades';
export type FinderMetric =
    | 'netProfit'
    | 'profitFactor'
    | 'sharpeRatio'
    | 'netProfitPercent'
    | 'winRate'
    | 'maxDrawdownPercent'
    | 'expectancy'
    | 'compositeEdgeRatio'
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

export interface FinderOptions {
    mode: FinderMode;
    sortPriority: FinderMetric[];
    useAdvancedSort: boolean;
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
