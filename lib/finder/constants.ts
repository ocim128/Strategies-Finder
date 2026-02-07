import type { FinderMetric } from "./types";

export const DEFAULT_SORT_PRIORITY: FinderMetric[] = [
	'oosDurabilityScore',
	'oosProfitFactor',
	'oosNetProfitPercent',
	'expectancy',
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
	oosDurabilityScore: 'OOS Dur',
	oosProfitFactor: 'OOS PF',
	oosNetProfitPercent: 'OOS %',
	netProfit: 'Net',
	profitFactor: 'PF',
	sharpeRatio: 'Sharpe',
	netProfitPercent: 'Net %',
	winRate: 'Win %',
	maxDrawdownPercent: 'DD %',
	expectancy: 'Exp',
	averageGain: 'Avg Gain',
	totalTrades: 'Trades'
};

export const METRIC_FULL_LABELS: Record<FinderMetric, string> = {
	oosDurabilityScore: 'OOS Durability Score',
	oosProfitFactor: 'OOS Profit Factor',
	oosNetProfitPercent: 'OOS Net Profit %',
	netProfit: 'Net Profit',
	profitFactor: 'Profit Factor',
	sharpeRatio: 'Sharpe Ratio',
	netProfitPercent: 'Net Profit %',
	winRate: 'Win Rate',
	maxDrawdownPercent: 'Max Drawdown %',
	expectancy: 'Expectancy',
	averageGain: 'Average Gain',
	totalTrades: 'Total Trades'
};
