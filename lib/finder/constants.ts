import type { FinderMetric, PolymarketFinderRankMode } from '../types/index';

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

export const METRIC_LABELS: Record<FinderMetric, string> = {
	netProfit: 'Net',
	profitFactor: 'PF',
	sharpeRatio: 'Sharpe',
	netProfitPercent: 'Net %',
	winRate: 'Win %',
	maxDrawdownPercent: 'DD %',
	expectancy: 'Exp',
	compositeEdgeRatio: 'Comp ER',
	averageGain: 'Avg Gain',
	totalTrades: 'Trades',
	polyScore: 'Poly Score',
	polyWins: 'Poly Wins',
	polyWinRate: 'Poly Win %',
	polyCoverage: 'Poly Cov %',
	polyPredictions: 'Poly Scored',
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
	averageGain: 'Average Gain',
	totalTrades: 'Total Trades',
	polyScore: 'Polymarket Balanced Score',
	polyWins: 'Polymarket Wins',
	polyWinRate: 'Poly Win Rate',
	polyCoverage: 'Poly Coverage',
	polyPredictions: 'Polymarket Scored Predictions',
};

export const POLYMARKET_RANK_MODE_LABELS: Record<PolymarketFinderRankMode, string> = {
	balanced: 'Balanced',
	accuracy: 'Accuracy',
	volume: 'Volume',
};

export function getPolymarketSortPriority(mode: PolymarketFinderRankMode = 'balanced'): FinderMetric[] {
	switch (mode) {
		case 'accuracy':
			return ['polyWinRate', 'polyPredictions', 'polyCoverage'];
		case 'volume':
			return ['polyWins', 'polyPredictions', 'polyWinRate'];
		case 'balanced':
		default:
			return ['polyScore', 'polyWinRate', 'polyPredictions'];
	}
}


