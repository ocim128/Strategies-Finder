import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { buildRollingSkewness, buildPercentileRank } from './price-action-statistics-core';
import { calculateATR } from '../indicators';

function normalizeSkewnessCompressionFlipParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(5, Math.round(params.lookback ?? 20)),
		atrPercentileThreshold: Math.max(0.01, Math.min(0.99, Number(params.atrPercentileThreshold ?? 0.15))),
	};
}

export const skewness_compression_flip: Strategy = {
	name: 'Skewness Compression Flip',
	description: 'Volatility is dead but the internal distribution of prices (skewness) suddenly violently polarizes, acting as a chaotic leading indicator of breakout direction.',
	defaultParams: {
		lookback: 20,
		atrPercentileThreshold: 0.15,
	},
	paramLabels: {
		lookback: 'Lookback',
		atrPercentileThreshold: 'ATR Percentile Threshold',
	},
	normalizeParams: normalizeSkewnessCompressionFlipParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeSkewnessCompressionFlipParams(params);
		const lookback = normalizedParams.lookback as number;
		const atrPctThresh = normalizedParams.atrPercentileThreshold as number;

		if (cleanData.length < lookback * 2) return [];

		const closes = getCloses(cleanData);
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);

		const atr = calculateATR(highs, lows, closes, lookback);
		const atrNonNull = atr.map(v => v !== null ? v as number : 0);
		const atrPercentile = buildPercentileRank(atrNonNull, lookback);
		const skewness = buildRollingSkewness(closes, lookback);

		return createSignalLoop(cleanData, [atrPercentile, skewness], (i) => {
			const pct = atrPercentile[i];
			const skew = skewness[i];
			const prevSkew = skewness[i - 1];
			if (pct === null || skew === null || prevSkew === null) return null;

			if (pct < atrPctThresh && prevSkew <= 1.0 && skew > 1.0) {
				return createBuySignal(cleanData, i, 'Skewness compression flip bullish');
			}
			if (pct < atrPctThresh && prevSkew >= -1.0 && skew < -1.0) {
				return createSellSignal(cleanData, i, 'Skewness compression flip bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['lookback', 'atrPercentileThreshold'],
	},
};
