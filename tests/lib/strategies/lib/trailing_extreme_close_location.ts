import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows } from '../strategy-helpers';
import { extractBarMetricSeries } from './price-action-statistics-core';
import { buildTrailingHighLow } from './price-action-frequency-core';

function normalizeTrailingExtremeCloseLocationParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(5, Math.round(params.lookback ?? 20)),
		closeLocExtreme: Math.max(0.5, Math.min(1.0, Number(params.closeLocExtreme ?? 0.9))),
	};
}

export const trailing_extreme_close_location: Strategy = {
	name: 'Trailing Extreme Close Location',
	description: 'Validates new trailing extremes by demanding the current bar\'s close location is exceptionally aggressive, ignoring weak breakouts.',
	defaultParams: {
		lookback: 20,
		closeLocExtreme: 0.9,
	},
	paramLabels: {
		lookback: 'Lookback',
		closeLocExtreme: 'Close Location Extreme',
	},
	normalizeParams: normalizeTrailingExtremeCloseLocationParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeTrailingExtremeCloseLocationParams(params);
		const lookback = normalizedParams.lookback as number;
		const closeLocExtreme = normalizedParams.closeLocExtreme as number;

		if (cleanData.length < lookback + 1) return [];

		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);

		const { highest, lowest } = buildTrailingHighLow(cleanData, lookback);
		const closeLocation = extractBarMetricSeries(cleanData, 'closeLocation');

		return createSignalLoop(cleanData, [highest, lowest], (i) => {
			const hi = highest[i - 1];
			const lo = lowest[i - 1];
			if (hi === null || lo === null) return null;

			const cl = closeLocation[i];

			if (highs[i] >= hi && cl > closeLocExtreme) {
				return createBuySignal(cleanData, i, 'Trailing extreme close location bullish');
			}
			if (lows[i] <= lo && cl < (1.0 - closeLocExtreme)) {
				return createSellSignal(cleanData, i, 'Trailing extreme close location bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['lookback', 'closeLocExtreme'],
	},
};
