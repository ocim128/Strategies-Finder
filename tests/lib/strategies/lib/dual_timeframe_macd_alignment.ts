import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from '../strategy-helpers';
import { buildDualTimeframeRatio } from './price-action-statistics-core';
import { calculateSMA, calculateMACD } from '../indicators';

function normalizeDualTimeframeMacdAlignmentParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		fastWindow: Math.max(2, Math.round(params.fastWindow ?? 5)),
		slowWindow: Math.max(3, Math.round(params.slowWindow ?? 20)),
	};
}

export const dual_timeframe_macd_alignment: Strategy = {
	name: 'Dual Timeframe MACD Alignment',
	description: 'Requires the higher timeframe close ratio to confirm expansion, entering when the lower timeframe MACD histogram crosses the zero line.',
	defaultParams: {
		fastWindow: 5,
		slowWindow: 20,
	},
	paramLabels: {
		fastWindow: 'Fast Window',
		slowWindow: 'Slow Window',
	},
	normalizeParams: normalizeDualTimeframeMacdAlignmentParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeDualTimeframeMacdAlignmentParams(params);
		const fastWindow = normalizedParams.fastWindow as number;
		const slowWindow = normalizedParams.slowWindow as number;

		if (cleanData.length < slowWindow + 26) return [];

		const closes = getCloses(cleanData);
		const dtfRatio = buildDualTimeframeRatio(closes, fastWindow, slowWindow, calculateSMA);
		const { histogram } = calculateMACD(closes, 12, 26, 9);

		return createSignalLoop(cleanData, [dtfRatio, histogram], (i) => {
			const ratio = dtfRatio[i];
			const h = histogram[i];
			const prevH = histogram[i - 1];
			if (ratio === null || h === null || prevH === null) return null;

			if (ratio > 1.0 && h > 0 && prevH <= 0) {
				return createBuySignal(cleanData, i, 'Dual TF MACD alignment bullish');
			}
			if (ratio < 1.0 && h < 0 && prevH >= 0) {
				return createSellSignal(cleanData, i, 'Dual TF MACD alignment bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['fastWindow', 'slowWindow'],
	},
};
