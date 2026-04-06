import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getVolumes } from '../strategy-helpers';
import { extractBarMetricSeries, buildRollingCorrelation } from './price-action-statistics-core';
import { buildTrailingHighLow } from './price-action-frequency-core';

function normalizeVolumeCloseCorrelationFadeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(5, Math.round(params.lookback ?? 20)),
		negativeCorrLimit: Math.max(-1.0, Math.min(-0.1, Number(params.negativeCorrLimit ?? -0.6))),
	};
}

export const volume_close_correlation_fade: Strategy = {
	name: 'Volume Close Correlation Fade',
	description: 'Fades breakout extremes where the correlation between the volume flow and the intra-bar close location is highly negative, revealing hidden institutional distribution.',
	defaultParams: {
		lookback: 20,
		negativeCorrLimit: -0.6,
	},
	paramLabels: {
		lookback: 'Lookback',
		negativeCorrLimit: 'Negative Correlation Limit',
	},
	normalizeParams: normalizeVolumeCloseCorrelationFadeParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeVolumeCloseCorrelationFadeParams(params);
		const lookback = np.lookback as number;
		const corrLimit = np.negativeCorrLimit as number;

		if (cleanData.length < lookback + 1) return [];

		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const volumes = getVolumes(cleanData);

		const { highest, lowest } = buildTrailingHighLow(cleanData, lookback);
		const closeLoc = extractBarMetricSeries(cleanData, 'closeLocation');
		const corr = buildRollingCorrelation(closeLoc, volumes, lookback);

		return createSignalLoop(cleanData, [highest, lowest, corr], (i) => {
			const hi = highest[i - 1];
			const lo = lowest[i - 1];
			const c = corr[i];
			if (hi === null || lo === null || c === null) return null;

			if (lows[i] <= lo && c < corrLimit) {
				return createBuySignal(cleanData, i, 'Volume close correlation fade bullish');
			}
			if (highs[i] >= hi && c < corrLimit) {
				return createSellSignal(cleanData, i, 'Volume close correlation fade bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['lookback', 'negativeCorrLimit'],
	},
};
