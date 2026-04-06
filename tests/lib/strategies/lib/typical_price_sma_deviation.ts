import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getTypicalPrices } from '../strategy-helpers';
import { calculateSMA } from '../indicators';

function normalizeTypicalPriceSmaDeviationParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(5, Math.round(params.lookback ?? 20)),
		deviationPct: Math.max(0.1, Number(params.deviationPct ?? 2.5)),
	};
}

export const typical_price_sma_deviation: Strategy = {
	name: 'Typical Price SMA Deviation',
	description: 'Fades extreme percentage deviations from the rolling average of Typical Price, anchoring to value rather than just the close.',
	defaultParams: {
		lookback: 20,
		deviationPct: 2.5,
	},
	paramLabels: {
		lookback: 'Lookback',
		deviationPct: 'Deviation %',
	},
	normalizeParams: normalizeTypicalPriceSmaDeviationParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeTypicalPriceSmaDeviationParams(params);
		const lookback = normalizedParams.lookback as number;
		const deviationPct = normalizedParams.deviationPct as number;

		if (cleanData.length < lookback + 1) return [];

		const typicalPrices = getTypicalPrices(cleanData);
		const sma = calculateSMA(typicalPrices, lookback);

		return createSignalLoop(cleanData, [sma], (i) => {
			const s = sma[i];
			if (s === null || s === 0) return null;

			const pctDev = ((typicalPrices[i] - s) / s) * 100;

			if (pctDev < -deviationPct) {
				return createBuySignal(cleanData, i, `Typical price ${pctDev.toFixed(1)}% below SMA`);
			}
			if (pctDev > deviationPct) {
				return createSellSignal(cleanData, i, `Typical price ${pctDev.toFixed(1)}% above SMA`);
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['lookback', 'deviationPct'],
	},
};
