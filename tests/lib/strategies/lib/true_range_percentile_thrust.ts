import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from '../strategy-helpers';
import { extractBarMetricSeries, buildPercentileRank } from './price-action-statistics-core';

function normalizeTrueRangePercentileThrustParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		rankLookback: Math.max(10, Math.round(params.rankLookback ?? 100)),
		trPercentileLimit: Math.max(0.5, Math.min(1.0, Number(params.trPercentileLimit ?? 0.95))),
		bodyPctThreshold: Math.max(0.1, Math.min(1.0, Number(params.bodyPctThreshold ?? 0.8))),
	};
}

export const true_range_percentile_thrust: Strategy = {
	name: 'True Range Percentile Thrust',
	description: 'Abandons rolling averages entirely, instead ranking the absolute True Range of the current bar against its history. Enters strictly when an extreme outlier bar is heavily directional.',
	defaultParams: {
		rankLookback: 100,
		trPercentileLimit: 0.95,
		bodyPctThreshold: 0.8,
	},
	paramLabels: {
		rankLookback: 'Rank Lookback',
		trPercentileLimit: 'TR Percentile Limit',
		bodyPctThreshold: 'Body % Threshold',
	},
	normalizeParams: normalizeTrueRangePercentileThrustParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeTrueRangePercentileThrustParams(params);
		const rankLb = np.rankLookback as number;
		const trLimit = np.trPercentileLimit as number;
		const bpThresh = np.bodyPctThreshold as number;

		if (cleanData.length < rankLb + 1) return [];

		const trueRange = extractBarMetricSeries(cleanData, 'trueRange');
		const bodyPct = extractBarMetricSeries(cleanData, 'bodyPct');
		const bodyDir = extractBarMetricSeries(cleanData, 'bodyDirection');

		const trRank = buildPercentileRank(trueRange, rankLb);

		return createSignalLoop(cleanData, [trRank], (i) => {
			const rank = trRank[i];
			if (rank === null) return null;

			if (rank > trLimit && bodyPct[i] > bpThresh && bodyDir[i] === 1) {
				return createBuySignal(cleanData, i, 'True range percentile thrust bullish');
			}
			if (rank > trLimit && bodyPct[i] > bpThresh && bodyDir[i] === -1) {
				return createSellSignal(cleanData, i, 'True range percentile thrust bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['rankLookback', 'trPercentileLimit', 'bodyPctThreshold'],
	},
};
