import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from '../strategy-helpers';
import { calculateDonchianChannels } from '../indicators';

function normalizeDonchianMidpointPullbackParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(5, Math.round(params.lookback ?? 20)),
	};
}

export const donchian_midpoint_pullback: Strategy = {
	name: 'Donchian Midpoint Pullback',
	description: 'Treats the midpoint of the Donchian Channel as a dynamic mean in an established trend, buying the first pullback to it.',
	defaultParams: {
		lookback: 20,
	},
	paramLabels: {
		lookback: 'Lookback',
	},
	normalizeParams: normalizeDonchianMidpointPullbackParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeDonchianMidpointPullbackParams(params);
		const lookback = normalizedParams.lookback as number;

		if (cleanData.length < lookback + 1) return [];

		const closes = getCloses(cleanData);
		const { middle } = calculateDonchianChannels(closes, closes, lookback);

		return createSignalLoop(cleanData, [middle], (i) => {
			const mid = middle[i];
			const prevMid = middle[i - 1];
			if (mid === null || prevMid === null) return null;

			if (mid > prevMid && closes[i - 1] >= prevMid && closes[i] < mid) {
				return createBuySignal(cleanData, i, 'Donchian midpoint pullback bullish');
			}
			if (mid < prevMid && closes[i - 1] <= prevMid && closes[i] > mid) {
				return createSellSignal(cleanData, i, 'Donchian midpoint pullback bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['lookback'],
	},
};
