import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from '../strategy-helpers';
import { buildPercentileRank } from './price-action-statistics-core';
import { calculateMACD } from '../indicators';

function normalizeMacdHistogramPercentileExhaustionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		percentileLookback: Math.max(10, Math.round(params.percentileLookback ?? 100)),
		extremeThreshold: Math.max(0.5, Math.min(0.99, Number(params.extremeThreshold ?? 0.95))),
	};
}

export const macd_histogram_percentile_exhaustion: Strategy = {
	name: 'MACD Histogram Percentile Exhaustion',
	description: 'Ranks the MACD histogram against its own history to find extreme momentum, fading exactly when that extreme momentum begins to decay.',
	defaultParams: {
		percentileLookback: 100,
		extremeThreshold: 0.95,
	},
	paramLabels: {
		percentileLookback: 'Percentile Lookback',
		extremeThreshold: 'Extreme Threshold',
	},
	normalizeParams: normalizeMacdHistogramPercentileExhaustionParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeMacdHistogramPercentileExhaustionParams(params);
		const pctLookback = normalizedParams.percentileLookback as number;
		const extremeThresh = normalizedParams.extremeThreshold as number;

		if (cleanData.length < pctLookback + 1) return [];

		const closes = getCloses(cleanData);
		const { histogram } = calculateMACD(closes, 12, 26, 9);
		const histNonNull = histogram.map(v => v !== null ? v as number : 0);
		const histPercentile = buildPercentileRank(histNonNull, pctLookback);

		return createSignalLoop(cleanData, [histogram, histPercentile], (i) => {
			const h = histogram[i];
			const prevH = histogram[i - 1];
			const pct = histPercentile[i];
			if (h === null || prevH === null || pct === null) return null;

			if (pct < (1.0 - extremeThresh) && h > prevH) {
				return createBuySignal(cleanData, i, 'MACD histogram exhaustion bullish');
			}
			if (pct > extremeThresh && h < prevH) {
				return createSellSignal(cleanData, i, 'MACD histogram exhaustion bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['percentileLookback', 'extremeThreshold'],
	},
};
