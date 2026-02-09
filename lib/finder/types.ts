import type { BacktestResult, StrategyParams } from "../strategies/index";

export type FinderMode = 'default' | 'grid' | 'random';
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
}
