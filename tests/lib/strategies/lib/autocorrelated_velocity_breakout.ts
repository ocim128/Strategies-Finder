import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from '../strategy-helpers';
import { buildRateOfChange, buildRollingAutoCorrelation } from './price-action-statistics-core';

function normalizeAutocorrelatedVelocityBreakoutParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		rocPeriod: Math.max(1, Math.round(params.rocPeriod ?? 5)),
		autoCorrLookback: Math.max(5, Math.round(params.autoCorrLookback ?? 30)),
		autoCorrThreshold: Math.max(0, Math.min(1.0, Number(params.autoCorrThreshold ?? 0.6))),
	};
}

export const autocorrelated_velocity_breakout: Strategy = {
	name: 'Autocorrelated Velocity Breakout',
	description: 'Takes momentum breakout trades exclusively when the underlying price series exhibits extreme statistical autocorrelation, confirming a non-random trend state.',
	defaultParams: {
		rocPeriod: 5,
		autoCorrLookback: 30,
		autoCorrThreshold: 0.6,
	},
	paramLabels: {
		rocPeriod: 'ROC Period',
		autoCorrLookback: 'Autocorrelation Lookback',
		autoCorrThreshold: 'Autocorrelation Threshold',
	},
	normalizeParams: normalizeAutocorrelatedVelocityBreakoutParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeAutocorrelatedVelocityBreakoutParams(params);
		const rocPeriod = np.rocPeriod as number;
		const acLookback = np.autoCorrLookback as number;
		const acThresh = np.autoCorrThreshold as number;

		if (cleanData.length < acLookback + rocPeriod + 1) return [];

		const closes = getCloses(cleanData);
		const autoCorr = buildRollingAutoCorrelation(closes, acLookback);
		const roc = buildRateOfChange(closes, rocPeriod);

		return createSignalLoop(cleanData, [autoCorr, roc], (i) => {
			const ac = autoCorr[i];
			const r = roc[i];
			const prevR = roc[i - 1];
			if (ac === null || r === null || prevR === null) return null;

			if (ac > acThresh && prevR <= 0 && r > 0) {
				return createBuySignal(cleanData, i, 'Autocorrelated velocity breakout bullish');
			}
			if (ac > acThresh && prevR >= 0 && r < 0) {
				return createSellSignal(cleanData, i, 'Autocorrelated velocity breakout bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['rocPeriod', 'autoCorrLookback', 'autoCorrThreshold'],
	},
};
