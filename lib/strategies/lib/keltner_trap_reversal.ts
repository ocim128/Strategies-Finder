import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { calculateKeltnerChannels } from '../indicators';

function normalizeKeltnerTrapReversalParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(5, Math.round(params.lookback ?? 20)),
		multiplier: Math.max(0.5, Number(params.multiplier ?? 2.0)),
	};
}

export const keltner_trap_reversal: Strategy = {
	name: 'Keltner Trap Reversal',
	description: 'Fades breakout attempts that pierce the outer Keltner Channels but fail to close outside them, trapping momentum traders.',
	defaultParams: {
		lookback: 20,
		multiplier: 2.0,
	},
	paramLabels: {
		lookback: 'Lookback',
		multiplier: 'Multiplier',
	},
	normalizeParams: normalizeKeltnerTrapReversalParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeKeltnerTrapReversalParams(params);
		const lookback = normalizedParams.lookback as number;
		const multiplier = normalizedParams.multiplier as number;

		if (cleanData.length < lookback + 1) return [];

		const closes = getCloses(cleanData);
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);

		const { upper, lower } = calculateKeltnerChannels(highs, lows, closes, lookback, lookback, multiplier);

		return createSignalLoop(cleanData, [upper, lower], (i) => {
			const up = upper[i];
			const dn = lower[i];
			if (up === null || dn === null) return null;

			if (lows[i] < dn && closes[i] > dn) {
				return createBuySignal(cleanData, i, 'Keltner trap reversal bullish');
			}
			if (highs[i] > up && closes[i] < up) {
				return createSellSignal(cleanData, i, 'Keltner trap reversal bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['lookback', 'multiplier'],
	},
};
