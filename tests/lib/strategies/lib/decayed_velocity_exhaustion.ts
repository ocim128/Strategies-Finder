import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from '../strategy-helpers';
import { buildRateOfChange, buildCumulativeDecaySum, buildRollingZScore } from './price-action-statistics-core';

function normalizeDecayedVelocityExhaustionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		rocPeriod: Math.max(1, Math.round(params.rocPeriod ?? 3)),
		decayFactor: Math.max(0.01, Math.min(0.999, Number(params.decayFactor ?? 0.85))),
		zscoreExtreme: Math.max(0.5, Number(params.zscoreExtreme ?? 2.5)),
	};
}

export const decayed_velocity_exhaustion: Strategy = {
	name: 'Decayed Velocity Exhaustion',
	description: 'Models the market\'s directional kinetic energy by applying a decay sum to its rate of change, fading the momentum only when this cumulative mass reaches a z-score extreme.',
	defaultParams: {
		rocPeriod: 3,
		decayFactor: 0.85,
		zscoreExtreme: 2.5,
	},
	paramLabels: {
		rocPeriod: 'ROC Period',
		decayFactor: 'Decay Factor',
		zscoreExtreme: 'Z-Score Extreme',
	},
	normalizeParams: normalizeDecayedVelocityExhaustionParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeDecayedVelocityExhaustionParams(params);
		const rocPeriod = np.rocPeriod as number;
		const decayFactor = np.decayFactor as number;
		const zsExtreme = np.zscoreExtreme as number;

		if (cleanData.length < rocPeriod + 21) return [];

		const closes = getCloses(cleanData);
		const roc = buildRateOfChange(closes, rocPeriod);
		const rocNonNull = roc.map(v => v ?? 0);
		const decayed = buildCumulativeDecaySum(rocNonNull, decayFactor);
		const zscore = buildRollingZScore(decayed, 20);

		return createSignalLoop(cleanData, [zscore], (i) => {
			const z = zscore[i];
			if (z === null) return null;

			if (z < -zsExtreme && cleanData[i].close > cleanData[i].open) {
				return createBuySignal(cleanData, i, 'Decayed velocity exhaustion bullish');
			}
			if (z > zsExtreme && cleanData[i].close < cleanData[i].open) {
				return createSellSignal(cleanData, i, 'Decayed velocity exhaustion bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['rocPeriod', 'decayFactor', 'zscoreExtreme'],
	},
};
