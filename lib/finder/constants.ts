import type { FinderMetric, FinderUniverseMetric, PolymarketFinderRankMode } from '../types/index';

export const DEFAULT_SORT_PRIORITY: FinderMetric[] = [
	'expectancy',
	'compositeEdgeRatio',
	'profitFactor',
	'totalTrades',
	'maxDrawdownPercent',
	'sharpeRatio',
	'averageGain',
	'winRate',
	'netProfitPercent',
	'netProfit'
];

export const FINDER_SORT_OPTIONS: FinderMetric[] = [
	'expectancy',
	'compositeEdgeRatio',
	'entryScore',
	'exitScore',
	'profitFactor',
	'totalTrades',
	'maxDrawdownPercent',
	'sharpeRatio',
	'averageGain',
	'winRate',
	'netProfitPercent',
	'netProfit'
];

export const METRIC_LABELS: Record<FinderMetric, string> = {
	netProfit: 'Net',
	profitFactor: 'PF',
	sharpeRatio: 'Sharpe',
	netProfitPercent: 'Net %',
	winRate: 'Win %',
	maxDrawdownPercent: 'DD %',
	expectancy: 'Exp',
	compositeEdgeRatio: 'Comp ER',
	entryScore: 'Entry',
	exitScore: 'Exit',
	averageGain: 'Avg Gain',
	totalTrades: 'Trades',
	polyScore: 'Poly Score',
	polyWins: 'Poly Wins',
	polyWinRate: 'Poly Win %',
	polyCoverage: 'Poly Cov %',
	polyPredictions: 'Poly Scored',
	polyExpectancy: 'Poly Exp',
	polyExpectancyBalance: 'Poly Exp+Trades',
	polyProfitFactor: 'Poly PF',
	polyProfitFactorBalance: 'Poly PF+Trades',
};

export const METRIC_FULL_LABELS: Record<FinderMetric, string> = {
	netProfit: 'Net Profit',
	profitFactor: 'Profit Factor',
	sharpeRatio: 'Sharpe Ratio',
	netProfitPercent: 'Net Profit %',
	winRate: 'Win Rate',
	maxDrawdownPercent: 'Max Drawdown %',
	expectancy: 'Expectancy',
	compositeEdgeRatio: 'Composite Edge Ratio',
	entryScore: 'Entry Score',
	exitScore: 'Exit Score',
	averageGain: 'Average Gain',
	totalTrades: 'Total Trades',
	polyScore: 'Polymarket Balanced Score',
	polyWins: 'Polymarket Wins',
	polyWinRate: 'Poly Win Rate',
	polyCoverage: 'Poly Coverage',
	polyPredictions: 'Polymarket Scored Predictions',
	polyExpectancy: 'Polymarket Expectancy',
	polyExpectancyBalance: 'Polymarket Expectancy + Trades Balance',
	polyProfitFactor: 'Polymarket Profit Factor',
	polyProfitFactorBalance: 'Polymarket Profit Factor + Trades Balance',
};

export const POLYMARKET_RANK_MODE_LABELS: Record<PolymarketFinderRankMode, string> = {
	balanced: 'Balanced',
	accuracy: 'Accuracy',
	volume: 'Volume',
	expectancy: 'Expectancy',
	expectancyTrades: 'Expectancy + Trades',
	profitFactor: 'Profit Factor',
	profitFactorTrades: 'Profit Factor + Trades',
};

export const UNIVERSE_METRIC_FULL_LABELS: Record<FinderUniverseMetric, string> = {
	profitableActiveRatio: 'Profitable Active Ratio',
	activeSymbols: 'Active Symbols',
	medianExpectancy: 'Median Expectancy',
	worstNetProfit: 'Worst Net Profit',
	totalTrades: 'Total Trades',
};

export function getPolymarketSortPriority(mode: PolymarketFinderRankMode = 'balanced'): FinderMetric[] {
	switch (mode) {
		case 'profitFactorTrades':
			return ['polyProfitFactorBalance', 'polyProfitFactor', 'totalTrades', 'polyPredictions', 'polyWinRate'];
		case 'profitFactor':
			return ['polyProfitFactor', 'polyPredictions', 'polyWinRate'];
		case 'expectancyTrades':
			return ['polyExpectancyBalance', 'polyExpectancy', 'totalTrades', 'polyPredictions', 'polyWinRate'];
		case 'expectancy':
			return ['polyExpectancy', 'polyWinRate', 'polyPredictions'];
		case 'accuracy':
			return ['polyWinRate', 'polyPredictions', 'polyCoverage'];
		case 'volume':
			return ['polyWins', 'polyPredictions', 'polyWinRate'];
		case 'balanced':
		default:
			return ['polyScore', 'polyWinRate', 'polyPredictions'];
	}
}


