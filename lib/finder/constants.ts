import type {
    FinderMetric,
    FinderStrategyQualityMetric,
    FinderUniverseMetric,
} from '../types/index';

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
	'exitAlpha',
	'profitFactor',
	'totalTrades',
	'maxDrawdownPercent',
	'sharpeRatio',
	'averageGain',
	'winRate',
	'netProfitPercent',
	'netProfit'
];

export const ADVANCED_OPTIONAL_SORT_METRICS: readonly FinderMetric[] = [
	'entryScore',
	'exitScore',
	'exitAlpha',
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
	exitAlpha: 'Exit α',
	averageGain: 'Avg Gain',
	payoffRatio: 'Payoff',
	totalTrades: 'Trades',
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
	exitAlpha: 'Exit Alpha',
	averageGain: 'Average Gain',
	payoffRatio: 'Payoff Ratio (Avg Win / Avg Loss)',
	totalTrades: 'Total Trades',
};

export const UNIVERSE_METRIC_FULL_LABELS: Record<FinderUniverseMetric, string> = {
    robustUniverseScore: 'Robust Universe Score',
    windowStabilityScore: 'Window Stability Score',
    profitableActiveRatio: 'Profitable Active Ratio',
    activeSymbols: 'Active Symbols',
    medianExpectancy: 'Median Expectancy',
    medianExpectancyWeightedTrades: 'Median Expectancy × Total Trades',
    medianSharpe: 'Median Sharpe Ratio',
    medianProfitFactor: 'Median Profit Factor',
    medianProfitFactorWeightedTrades: 'Median Profit Factor × Total Trades',
    medianCompositeEdgeRatio: 'Median Composite Edge Ratio',
    medianExitAlpha: 'Median Exit Alpha',
    worstMaxDrawdownPercent: 'Worst-Symbol Max Drawdown',
    medianMaxDrawdownPercent: 'Median Max Drawdown',
    medianReturnDrawdownRatio: 'Median Return / Drawdown Ratio',
    worstNetProfit: 'Worst Net Profit',
    totalTrades: 'Total Trades',
};

export const STRATEGY_QUALITY_SORT_OPTIONS: FinderStrategyQualityMetric[] = [
    'medianExpectancy',
    'averageExpectancy',
    'averageProfitFactor',
    'profitFactor',
    'averageSharpe',
    'profitableActiveRatio',
    'weightedWinRate',
    'totalNetProfit',
    'totalTrades',
    'activeRatio',
    'activeSymbols',
    'profitableSymbols',
    'noTradeSymbols',
    'worstMaxDrawdownPercent',
];

export const STRATEGY_QUALITY_METRIC_FULL_LABELS: Record<FinderStrategyQualityMetric, string> = {
    averageExpectancy: 'Average Expectancy',
    medianExpectancy: 'Median Expectancy',
    profitFactor: 'Profit Factor',
    averageProfitFactor: 'Average Profit Factor',
    averageSharpe: 'Average Sharpe Ratio',
    weightedWinRate: 'Weighted Win Rate',
    totalNetProfit: 'Total Net Profit',
    totalTrades: 'Total Trades',
    activeSymbols: 'Active Symbols',
    activeRatio: 'Active Symbol Ratio',
    profitableSymbols: 'Profitable Symbols',
    profitableActiveRatio: 'Profitable Active Ratio',
    noTradeSymbols: 'No-Trade Symbols',
    worstMaxDrawdownPercent: 'Worst Max Drawdown',
};
