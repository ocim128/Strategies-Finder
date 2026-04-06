import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses } from '../strategy-helpers';

function normalizeInsideBarFalseBreakoutParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		minRangeThreshold: Math.max(0, Number(params.minRangeThreshold ?? 0.001)),
	};
}

export const inside_bar_false_breakout: Strategy = {
	name: 'Inside Bar False Breakout',
	description: 'Fades inside bar breakouts that immediately fail, trapping breakout traders in a tight liquidity pocket.',
	defaultParams: {
		minRangeThreshold: 0.001,
	},
	paramLabels: {
		minRangeThreshold: 'Min Range Threshold',
	},
	normalizeParams: normalizeInsideBarFalseBreakoutParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeInsideBarFalseBreakoutParams(params);
		const minRange = normalizedParams.minRangeThreshold as number;

		if (cleanData.length < 3) return [];

		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const closes = getCloses(cleanData);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < 2) return null;

			const motherHigh = highs[i - 2];
			const motherLow = lows[i - 2];
			const motherRange = motherHigh - motherLow;
			if (motherRange < minRange) return null;

			const prevHigh = highs[i - 1];
			const prevLow = lows[i - 1];
			if (prevHigh >= motherHigh || prevLow <= motherLow) return null;

			if (lows[i] < prevLow && closes[i] > prevHigh) {
				return createBuySignal(cleanData, i, 'Inside bar false breakout bullish');
			}
			if (highs[i] > prevHigh && closes[i] < prevLow) {
				return createSellSignal(cleanData, i, 'Inside bar false breakout bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['minRangeThreshold'],
	},
};
