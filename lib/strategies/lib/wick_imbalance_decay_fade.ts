import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from '../strategy-helpers';
import { extractBarMetricSeries, buildCumulativeDecaySum, buildRollingZScore } from './price-action-statistics-core';

function normalizeWickImbalanceDecayFadeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		decayRate: Math.max(0.01, Math.min(0.999, Number(params.decayRate ?? 0.75))),
		zscoreExtreme: Math.max(0.5, Number(params.zscoreExtreme ?? 2.5)),
	};
}

export const wick_imbalance_decay_fade: Strategy = {
	name: 'Wick Imbalance Decay Fade',
	description: 'Models sequential wick rejections as a coiled spring using a cumulative decay sum. When the decayed sum reaches a statistical extreme, the rejection is exhausted.',
	defaultParams: {
		decayRate: 0.75,
		zscoreExtreme: 2.5,
	},
	paramLabels: {
		decayRate: 'Decay Rate',
		zscoreExtreme: 'Z-Score Extreme',
	},
	normalizeParams: normalizeWickImbalanceDecayFadeParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeWickImbalanceDecayFadeParams(params);
		const decayRate = normalizedParams.decayRate as number;
		const zscoreExtreme = normalizedParams.zscoreExtreme as number;

		if (cleanData.length < 20) return [];

		const wickImbalance = extractBarMetricSeries(cleanData, 'wickImbalance');
		const decayed = buildCumulativeDecaySum(wickImbalance, decayRate);
		const zscore = buildRollingZScore(decayed, 20);

		return createSignalLoop(cleanData, [zscore], (i) => {
			const z = zscore[i];
			if (z === null) return null;

			if (z < -zscoreExtreme) {
				return createBuySignal(cleanData, i, 'Wick imbalance decay fade buy');
			}
			if (z > zscoreExtreme) {
				return createSellSignal(cleanData, i, 'Wick imbalance decay fade sell');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['decayRate', 'zscoreExtreme'],
	},
};
