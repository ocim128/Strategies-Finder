import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getTypicalPrices } from '../strategy-helpers';
import { buildRateOfChange, buildRollingZScore } from './price-action-statistics-core';

function normalizeTypicalPriceVelocitySnapParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		rocLookback: Math.max(1, Math.round(params.rocLookback ?? 3)),
		zscoreLookback: Math.max(5, Math.round(params.zscoreLookback ?? 100)),
		velocityZScore: Math.max(0.5, Number(params.velocityZScore ?? 3.0)),
	};
}

export const typical_price_velocity_snap: Strategy = {
	name: 'Typical Price Velocity Snap',
	description: 'Measures the velocity of the Typical Price rather than the Close, fading velocity spikes that hit a historical Z-Score extreme.',
	defaultParams: {
		rocLookback: 3,
		zscoreLookback: 100,
		velocityZScore: 3.0,
	},
	paramLabels: {
		rocLookback: 'ROC Lookback',
		zscoreLookback: 'Z-Score Lookback',
		velocityZScore: 'Velocity Z-Score',
	},
	normalizeParams: normalizeTypicalPriceVelocitySnapParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeTypicalPriceVelocitySnapParams(params);
		const rocLookback = normalizedParams.rocLookback as number;
		const zsLookback = normalizedParams.zscoreLookback as number;
		const velThresh = normalizedParams.velocityZScore as number;

		if (cleanData.length < zsLookback + rocLookback + 1) return [];

		const typicalPrices = getTypicalPrices(cleanData);
		const roc = buildRateOfChange(typicalPrices, rocLookback);
		const rocNonNull = roc.map(v => v ?? 0);
		const zscore = buildRollingZScore(rocNonNull, zsLookback);

		return createSignalLoop(cleanData, [zscore], (i) => {
			const z = zscore[i];
			if (z === null) return null;

			if (z < -velThresh && cleanData[i].close > cleanData[i].open) {
				return createBuySignal(cleanData, i, 'Typical price velocity snap bullish');
			}
			if (z > velThresh && cleanData[i].close < cleanData[i].open) {
				return createSellSignal(cleanData, i, 'Typical price velocity snap bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['rocLookback', 'zscoreLookback', 'velocityZScore'],
	},
};
