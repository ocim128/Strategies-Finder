import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { buildPercentileRank, buildRollingMedian } from './price-action-statistics-core';
import { calculateATR } from '../indicators';

function normalizeAtrPercentileMedianBreakoutParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		atrLookback: Math.max(2, Math.round(params.atrLookback ?? 14)),
		percentileLookback: Math.max(10, Math.round(params.percentileLookback ?? 100)),
		compressionThreshold: Math.max(0.01, Math.min(0.5, Number(params.compressionThreshold ?? 0.10))),
	};
}

export const atr_percentile_median_breakout: Strategy = {
	name: 'ATR Percentile Median Breakout',
	description: 'Waits for volatility to contract to a historical extreme (lowest ATR percentile), then buys the first directional cross of the rolling median price.',
	defaultParams: {
		atrLookback: 14,
		percentileLookback: 100,
		compressionThreshold: 0.10,
	},
	paramLabels: {
		atrLookback: 'ATR Lookback',
		percentileLookback: 'Percentile Lookback',
		compressionThreshold: 'Compression Threshold',
	},
	normalizeParams: normalizeAtrPercentileMedianBreakoutParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeAtrPercentileMedianBreakoutParams(params);
		const atrLookback = normalizedParams.atrLookback as number;
		const pctLookback = normalizedParams.percentileLookback as number;
		const compThresh = normalizedParams.compressionThreshold as number;

		if (cleanData.length < pctLookback + 1) return [];

		const closes = getCloses(cleanData);
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);

		const atr = calculateATR(highs, lows, closes, atrLookback);
		const atrNonNull = atr.map(v => v !== null ? v as number : 0);
		const atrPercentile = buildPercentileRank(atrNonNull, pctLookback);
		const median = buildRollingMedian(closes, atrLookback);

		return createSignalLoop(cleanData, [atrPercentile, median], (i) => {
			const pct = atrPercentile[i];
			const med = median[i];
			const prevMed = median[i - 1];
			if (pct === null || med === null || prevMed === null) return null;

			if (pct < compThresh && closes[i - 1] <= prevMed && closes[i] > med) {
				return createBuySignal(cleanData, i, 'ATR percentile median breakout bullish');
			}
			if (pct < compThresh && closes[i - 1] >= prevMed && closes[i] < med) {
				return createSellSignal(cleanData, i, 'ATR percentile median breakout bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['atrLookback', 'percentileLookback', 'compressionThreshold'],
	},
};
