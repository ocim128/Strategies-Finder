import type { BacktestResult, StrategyParams } from "../types/strategies";

export type FinderMode = 'default' | 'grid' | 'random' | 'robust_random_wf';
export type FinderMetric =
    | 'netProfit'
    | 'profitFactor'
    | 'sharpeRatio'
    | 'netProfitPercent'
    | 'winRate'
    | 'maxDrawdownPercent'
    | 'expectancy'
    | 'averageGain'
    | 'totalTrades';

export interface FinderOptions {
    mode: FinderMode;
    sortPriority: FinderMetric[];
    useAdvancedSort: boolean;
    robustSeed?: number;
    multiTimeframeEnabled?: boolean;
    timeframes?: string[];
    topN: number;
    steps: number;
    rangePercent: number;
    maxRuns: number;
    tradeFilterEnabled: boolean;
    minTrades: number;
    maxTrades: number;
}

export interface EndpointSelectionAdjustment {
    result: BacktestResult;
    adjusted: boolean;
    removedTrades: number;
}

export interface FinderResult {
    key: string;
    name: string;
    timeframes?: string[];
    params: StrategyParams;
    /** Raw backtest result (includes any final forced liquidation). */
    result: BacktestResult;
    /** Selection result with endpoint-bias trades removed. */
    selectionResult: BacktestResult;
    endpointAdjusted: boolean;
    endpointRemovedTrades: number;
    confirmationParams?: Record<string, StrategyParams>;
    robustMetrics?: {
        mode: 'robust_random_wf';
        seed: number;
        cellSeed: number;
        decision: 'PASS' | 'FAIL';
        decisionReason: string;
        timeframe: string;
        sampledParams: number;
        stageASurvivors: number;
        stageBSurvivors: number;
        stageCSurvivors: number;
        passRate: number;
        topDecileMedianOOSExpectancy: number;
        topDecileMedianProfitableFoldRatio: number;
        medianFoldStabilityPenalty: number;
        topDecileMedianDDBreachRate: number;
        robustScore: number;
        rejectionReasons: Record<string, number>;
    };
}
