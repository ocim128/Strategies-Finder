import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from '../strategy-helpers';
import { buildPercentileRank } from './price-action-statistics-core';
import { buildTrailingHighLow } from './price-action-frequency-core';

function normalizeTrailingRangeCompressionBreakoutParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		rangeLookback: Math.max(5, Math.round(params.rangeLookback ?? 20)),
		compressionPercentile: Math.max(0.01, Math.min(0.5, Number(params.compressionPercentile ?? 0.05))),
	};
}

export const trailing_range_compression_breakout: Strategy = {
	name: 'Trailing Range Compression Breakout',
	description: 'Measures the absolute distance between the trailing high and trailing low. Breaks out when this absolute range hits a historical extreme low percentile.',
	defaultParams: {
		rangeLookback: 20,
		compressionPercentile: 0.05,
	},
	paramLabels: {
		rangeLookback: 'Range Lookback',
		compressionPercentile: 'Compression Percentile',
	},
	normalizeParams: normalizeTrailingRangeCompressionBreakoutParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeTrailingRangeCompressionBreakoutParams(params);
		const rangeLookback = normalizedParams.rangeLookback as number;
		const compPct = normalizedParams.compressionPercentile as number;

		if (cleanData.length < rangeLookback * 2) return [];

		const closes = getCloses(cleanData);
		const { highest, lowest } = buildTrailingHighLow(cleanData, rangeLookback);

		const rangeSeries: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			const hi = highest[i];
			const lo = lowest[i];
			if (hi !== null && lo !== null) {
				rangeSeries[i] = hi - lo;
			}
		}

		const rangePct = buildPercentileRank(rangeSeries, rangeLookback);

		return createSignalLoop(cleanData, [highest, lowest, rangePct], (i) => {
			const pct = rangePct[i];
			const prevHi = highest[i - 1];
			const prevLo = lowest[i - 1];
			if (pct === null || prevHi === null || prevLo === null) return null;

			if (pct < compPct && closes[i] > prevHi) {
				return createBuySignal(cleanData, i, 'Trailing range compression breakout bullish');
			}
			if (pct < compPct && closes[i] < prevLo) {
				return createSellSignal(cleanData, i, 'Trailing range compression breakout bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['rangeLookback', 'compressionPercentile'],
	},
};
