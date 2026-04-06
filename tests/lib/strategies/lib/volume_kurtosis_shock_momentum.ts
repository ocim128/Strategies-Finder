import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from '../strategy-helpers';
import { buildRollingKurtosis, extractBarMetricSeries } from './price-action-statistics-core';
import { getVolumes } from '../strategy-helpers';

function normalizeVolumeKurtosisShockMomentumParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(5, Math.round(params.lookback ?? 40)),
		kurtosisSpikeThreshold: Math.max(0, Number(params.kurtosisSpikeThreshold ?? 6.0)),
	};
}

export const volume_kurtosis_shock_momentum: Strategy = {
	name: 'Volume Kurtosis Shock Momentum',
	description: 'Identifies massive, fat-tailed liquidity shocks in volume distribution (liquidation cascades) and blindly follows the direction of the bar that caused it.',
	defaultParams: {
		lookback: 40,
		kurtosisSpikeThreshold: 6.0,
	},
	paramLabels: {
		lookback: 'Lookback',
		kurtosisSpikeThreshold: 'Kurtosis Spike Threshold',
	},
	normalizeParams: normalizeVolumeKurtosisShockMomentumParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeVolumeKurtosisShockMomentumParams(params);
		const lookback = normalizedParams.lookback as number;
		const kurtThresh = normalizedParams.kurtosisSpikeThreshold as number;

		if (cleanData.length < lookback + 1) return [];

		const volumes = getVolumes(cleanData);
		const kurtosis = buildRollingKurtosis(volumes, lookback);
		const bodyDirection = extractBarMetricSeries(cleanData, 'bodyDirection');

		return createSignalLoop(cleanData, [kurtosis], (i) => {
			const k = kurtosis[i];
			if (k === null) return null;

			if (k > kurtThresh && bodyDirection[i] === 1) {
				return createBuySignal(cleanData, i, `Volume kurtosis shock bullish (${k.toFixed(1)})`);
			}
			if (k > kurtThresh && bodyDirection[i] === -1) {
				return createSellSignal(cleanData, i, `Volume kurtosis shock bearish (${k.toFixed(1)})`);
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['lookback', 'kurtosisSpikeThreshold'],
	},
};
