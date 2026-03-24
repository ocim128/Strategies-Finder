import type { FinderMetric } from '../types/index';

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
	polyWinRate: 'Poly Win %',
	polyCoverage: 'Poly Cov %',
	polyPredictions: 'Poly Pred',
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
	polyWinRate: 'Poly Win Rate',
	polyCoverage: 'Poly Coverage',
	polyPredictions: 'Poly Predictions',
};

export const POLYMARKET_SORT_PRIORITY: FinderMetric[] = [
	'polyWinRate',
	'polyPredictions',
	'polyCoverage',
];


