import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from '../strategy-helpers';
import { extractBarMetricSeries } from './price-action-statistics-core';
import { buildRollingAverage } from './price-action-frequency-core';

function normalizeVolumeClimaxPinBarParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		volLookback: Math.max(5, Math.round(params.volLookback ?? 20)),
		volMultiplier: Math.max(1.0, Number(params.volMultiplier ?? 2.5)),
		wickRatioThreshold: Math.max(0.1, Math.min(1.0, Number(params.wickRatioThreshold ?? 0.65))),
	};
}

export const volume_climax_pin_bar: Strategy = {
	name: 'Volume Climax Pin Bar',
	description: 'Locates classic pin-bars (long wicks, small bodies) that occur strictly on massive relative volume, indicating institutional capitulation at an extreme.',
	defaultParams: {
		volLookback: 20,
		volMultiplier: 2.5,
		wickRatioThreshold: 0.65,
	},
	paramLabels: {
		volLookback: 'Volume Lookback',
		volMultiplier: 'Volume Multiplier',
		wickRatioThreshold: 'Wick Ratio Threshold',
	},
	normalizeParams: normalizeVolumeClimaxPinBarParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeVolumeClimaxPinBarParams(params);
		const volLookback = normalizedParams.volLookback as number;
		const volMult = normalizedParams.volMultiplier as number;
		const wickThresh = normalizedParams.wickRatioThreshold as number;

		if (cleanData.length < volLookback + 1) return [];

		const volumes = getVolumes(cleanData);
		const volSma = buildRollingAverage(volumes, volLookback);

		const lowerWick = extractBarMetricSeries(cleanData, 'lowerWick');
		const upperWick = extractBarMetricSeries(cleanData, 'upperWick');
		const range = extractBarMetricSeries(cleanData, 'range');

		return createSignalLoop(cleanData, [volSma], (i) => {
			const sma = volSma[i];
			if (sma === null) return null;

			const vol = volumes[i];
			const rng = range[i];
			if (rng <= 0) return null;

			if (vol > sma * volMult && (lowerWick[i] / rng) > wickThresh && cleanData[i].close > cleanData[i].open) {
				return createBuySignal(cleanData, i, 'Volume climax pin bar bullish');
			}
			if (vol > sma * volMult && (upperWick[i] / rng) > wickThresh && cleanData[i].close < cleanData[i].open) {
				return createSellSignal(cleanData, i, 'Volume climax pin bar bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['volLookback', 'volMultiplier', 'wickRatioThreshold'],
	},
};
