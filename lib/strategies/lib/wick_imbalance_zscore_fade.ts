import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from '../strategy-helpers';
import { extractBarMetricSeries, buildRollingZScore } from './price-action-statistics-core';

function normalizeWickImbalanceZscoreFadeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		zscoreLookback: Math.max(5, Math.round(params.zscoreLookback ?? 50)),
		zscoreThreshold: Math.max(0.5, Number(params.zscoreThreshold ?? 2.5)),
	};
}

export const wick_imbalance_zscore_fade: Strategy = {
	name: 'Wick Imbalance Z-Score Fade',
	description: 'Fades extremes in structural absorption by converting the wick imbalance metric into a rolling Z-Score, striking when the imbalance becomes a statistical anomaly.',
	defaultParams: {
		zscoreLookback: 50,
		zscoreThreshold: 2.5,
	},
	paramLabels: {
		zscoreLookback: 'Z-Score Lookback',
		zscoreThreshold: 'Z-Score Threshold',
	},
	normalizeParams: normalizeWickImbalanceZscoreFadeParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeWickImbalanceZscoreFadeParams(params);
		const lookback = normalizedParams.zscoreLookback as number;
		const threshold = normalizedParams.zscoreThreshold as number;

		if (cleanData.length < lookback + 1) return [];

		const wickImbalance = extractBarMetricSeries(cleanData, 'wickImbalance');
		const zscore = buildRollingZScore(wickImbalance, lookback);

		return createSignalLoop(cleanData, [zscore], (i) => {
			const z = zscore[i];
			if (z === null) return null;

			if (z < -threshold && cleanData[i].close > cleanData[i].open) {
				return createBuySignal(cleanData, i, 'Wick imbalance z-score fade bullish');
			}
			if (z > threshold && cleanData[i].close < cleanData[i].open) {
				return createSellSignal(cleanData, i, 'Wick imbalance z-score fade bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['zscoreLookback', 'zscoreThreshold'],
	},
};
