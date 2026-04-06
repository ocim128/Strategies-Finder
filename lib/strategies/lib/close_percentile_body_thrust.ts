import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from '../strategy-helpers';
import { buildPercentileRank, extractBarMetricSeries } from './price-action-statistics-core';

function normalizeClosePercentileBodyThrustParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		rankLookback: Math.max(5, Math.round(params.rankLookback ?? 50)),
		bodyPctThreshold: Math.max(0.1, Math.min(1.0, Number(params.bodyPctThreshold ?? 0.85))),
	};
}

export const close_percentile_body_thrust: Strategy = {
	name: 'Close Percentile Body Thrust',
	description: 'Enters a trend only when the Close hits the absolute 100th/0th percentile of its recent history AND the breakout bar is almost entirely solid body.',
	defaultParams: {
		rankLookback: 50,
		bodyPctThreshold: 0.85,
	},
	paramLabels: {
		rankLookback: 'Rank Lookback',
		bodyPctThreshold: 'Body % Threshold',
	},
	normalizeParams: normalizeClosePercentileBodyThrustParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeClosePercentileBodyThrustParams(params);
		const rankLookback = normalizedParams.rankLookback as number;
		const bodyThresh = normalizedParams.bodyPctThreshold as number;

		if (cleanData.length < rankLookback + 1) return [];

		const closes = getCloses(cleanData);
		const closeRank = buildPercentileRank(closes, rankLookback);
		const bodyPct = extractBarMetricSeries(cleanData, 'bodyPct');
		const bodyDir = extractBarMetricSeries(cleanData, 'bodyDirection');

		return createSignalLoop(cleanData, [closeRank], (i) => {
			const rank = closeRank[i];
			if (rank === null) return null;

			if (rank >= 1.0 && bodyPct[i] > bodyThresh && bodyDir[i] === 1) {
				return createBuySignal(cleanData, i, 'Close percentile body thrust bullish');
			}
			if (rank <= 0.0 && bodyPct[i] > bodyThresh && bodyDir[i] === -1) {
				return createSellSignal(cleanData, i, 'Close percentile body thrust bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['rankLookback', 'bodyPctThreshold'],
	},
};
