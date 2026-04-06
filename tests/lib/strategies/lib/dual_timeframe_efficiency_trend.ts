import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getTypicalPrices } from '../strategy-helpers';
import { buildDualTimeframeRatio, buildEfficiencyRatio, extractBarMetricSeries } from './price-action-statistics-core';
import { calculateSMA } from '../indicators';

function normalizeDualTimeframeEfficiencyTrendParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		slowWindow: Math.max(3, Math.round(params.slowWindow ?? 20)),
		erLookback: Math.max(2, Math.round(params.erLookback ?? 14)),
		erThreshold: Math.max(0.01, Math.min(1.0, Number(params.erThreshold ?? 0.4))),
	};
}

export const dual_timeframe_efficiency_trend: Strategy = {
	name: 'Dual Timeframe Efficiency Trend',
	description: 'Anchors to a higher-timeframe macro vector, executing micro entries only when Kaufman\'s Efficiency Ratio proves the local price action is frictionless.',
	defaultParams: {
		slowWindow: 20,
		erLookback: 14,
		erThreshold: 0.4,
	},
	paramLabels: {
		slowWindow: 'Slow Window',
		erLookback: 'ER Lookback',
		erThreshold: 'ER Threshold',
	},
	normalizeParams: normalizeDualTimeframeEfficiencyTrendParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeDualTimeframeEfficiencyTrendParams(params);
		const slowWindow = np.slowWindow as number;
		const erLookback = np.erLookback as number;
		const erThresh = np.erThreshold as number;
		const fastWindow = Math.max(1, Math.round(slowWindow / 4));

		if (cleanData.length < slowWindow + erLookback + 1) return [];

		const typicalPrices = getTypicalPrices(cleanData);
		const dtfRatio = buildDualTimeframeRatio(typicalPrices, fastWindow, slowWindow, calculateSMA);
		const er = buildEfficiencyRatio(cleanData, erLookback);
		const bodyDir = extractBarMetricSeries(cleanData, 'bodyDirection');

		return createSignalLoop(cleanData, [dtfRatio, er], (i) => {
			const ratio = dtfRatio[i];
			const e = er[i];
			if (ratio === null || e === null) return null;

			if (ratio > 1.0 && e > erThresh && bodyDir[i] === 1) {
				return createBuySignal(cleanData, i, 'Dual TF efficiency trend bullish');
			}
			if (ratio < 1.0 && e > erThresh && bodyDir[i] === -1) {
				return createSellSignal(cleanData, i, 'Dual TF efficiency trend bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['slowWindow', 'erLookback', 'erThreshold'],
	},
};
