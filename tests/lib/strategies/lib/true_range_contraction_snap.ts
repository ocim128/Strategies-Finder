import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { buildStreakCount, extractBarMetricSeries } from './price-action-statistics-core';

function normalizeTrueRangeContractionSnapParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		streakRequired: Math.max(2, Math.round(params.streakRequired ?? 3)),
	};
}

export const true_range_contraction_snap: Strategy = {
	name: 'True Range Contraction Snap',
	description: 'Counts consecutive bars where the True Range is strictly decreasing, entering on the first bar that breaks the prior high/low.',
	defaultParams: {
		streakRequired: 3,
	},
	paramLabels: {
		streakRequired: 'Streak Required',
	},
	normalizeParams: normalizeTrueRangeContractionSnapParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeTrueRangeContractionSnapParams(params);
		const streakRequired = normalizedParams.streakRequired as number;

		if (cleanData.length < streakRequired + 2) return [];

		const closes = getCloses(cleanData);
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);

		const trueRange = extractBarMetricSeries(cleanData, 'trueRange');
		const decreasingFlags = new Array(cleanData.length).fill(0);
		for (let i = 1; i < cleanData.length; i++) {
			if (trueRange[i] < trueRange[i - 1]) decreasingFlags[i] = 1;
		}

		const streaks = buildStreakCount(decreasingFlags);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < 2) return null;

			const prevStreak = streaks[i - 1];
			if (prevStreak < streakRequired) return null;

			if (closes[i] > highs[i - 1]) {
				return createBuySignal(cleanData, i, `TR contraction snap bullish (${prevStreak} bars)`);
			}
			if (closes[i] < lows[i - 1]) {
				return createSellSignal(cleanData, i, `TR contraction snap bearish (${prevStreak} bars)`);
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['streakRequired'],
	},
};
