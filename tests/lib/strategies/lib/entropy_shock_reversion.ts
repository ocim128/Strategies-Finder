import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from '../strategy-helpers';
import { buildRollingEntropy, buildRollingZScore } from './price-action-statistics-core';

function normalizeEntropyShockReversionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(5, Math.round(params.lookback ?? 30)),
		entropySpikeThreshold: Math.max(0.1, Number(params.entropySpikeThreshold ?? 2.0)),
		zscoreExtreme: Math.max(0.5, Number(params.zscoreExtreme ?? 2.5)),
	};
}

export const entropy_shock_reversion: Strategy = {
	name: 'Entropy Shock Reversion',
	description: 'Fades extreme price deviations that manifest exactly at the moment the market transitions from perfect algorithmic order (low entropy) to sudden chaos.',
	defaultParams: {
		lookback: 30,
		entropySpikeThreshold: 2.0,
		zscoreExtreme: 2.5,
	},
	paramLabels: {
		lookback: 'Lookback',
		entropySpikeThreshold: 'Entropy Spike Threshold',
		zscoreExtreme: 'Z-Score Extreme',
	},
	normalizeParams: normalizeEntropyShockReversionParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeEntropyShockReversionParams(params);
		const lookback = np.lookback as number;
		const entThresh = np.entropySpikeThreshold as number;
		const zsExtreme = np.zscoreExtreme as number;

		if (cleanData.length < lookback + 2) return [];

		const closes = getCloses(cleanData);
		const returns = new Array(cleanData.length).fill(0);
		for (let i = 1; i < cleanData.length; i++) {
			returns[i] = closes[i] !== closes[i - 1] ? (closes[i] - closes[i - 1]) / closes[i - 1] : 0;
		}

		const entropy = buildRollingEntropy(returns, lookback);
		const priceZscore = buildRollingZScore(closes, lookback);

		return createSignalLoop(cleanData, [entropy, priceZscore], (i) => {
			const ent = entropy[i];
			const prevEnt = entropy[i - 1];
			const pz = priceZscore[i];
			if (ent === null || prevEnt === null || pz === null) return null;

			if (prevEnt <= entThresh && ent > entThresh && pz < -zsExtreme) {
				return createBuySignal(cleanData, i, 'Entropy shock reversion bullish');
			}
			if (prevEnt <= entThresh && ent > entThresh && pz > zsExtreme) {
				return createSellSignal(cleanData, i, 'Entropy shock reversion bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['lookback', 'entropySpikeThreshold', 'zscoreExtreme'],
	},
};
