import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { calculateKeltnerChannels } from '../indicators';

function normalizeKeltnerChurnBreakoutParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		keltnerPeriod: Math.max(5, Math.round(params.keltnerPeriod ?? 20)),
		churnLookback: Math.max(2, Math.round(params.churnLookback ?? 20)),
		minCrossings: Math.max(1, Math.round(params.minCrossings ?? 6)),
	};
}

export const keltner_churn_breakout: Strategy = {
	name: 'Keltner Churn Breakout',
	description: 'Filters Keltner Channel breakouts by demanding the asset first experienced an extreme phase of zero-sum mean reversion, quantified by a high frequency of midpoint crossings.',
	defaultParams: {
		keltnerPeriod: 20,
		churnLookback: 20,
		minCrossings: 6,
	},
	paramLabels: {
		keltnerPeriod: 'Keltner Period',
		churnLookback: 'Churn Lookback',
		minCrossings: 'Min Crossings',
	},
	normalizeParams: normalizeKeltnerChurnBreakoutParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeKeltnerChurnBreakoutParams(params);
		const kPeriod = np.keltnerPeriod as number;
		const churnLb = np.churnLookback as number;
		const minCross = np.minCrossings as number;

		if (cleanData.length < kPeriod + churnLb + 1) return [];

		const closes = getCloses(cleanData);
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);

		const { upper, lower, middle } = calculateKeltnerChannels(highs, lows, closes, kPeriod, kPeriod, 2.0);

		const midCrossings: number[] = new Array(cleanData.length).fill(0);
		for (let i = 1; i < cleanData.length; i++) {
			const m = middle[i];
			const prevM = middle[i - 1];
			if (m === null || prevM === null) continue;
			if ((closes[i - 1] <= prevM && closes[i] > m) || (closes[i - 1] >= prevM && closes[i] < m)) {
				midCrossings[i] = 1;
			}
		}

		const midCrossingSum: (number | null)[] = new Array(cleanData.length).fill(null);
		for (let i = churnLb - 1; i < cleanData.length; i++) {
			let count = 0;
			for (let j = i - churnLb + 1; j <= i; j++) {
				count += midCrossings[j];
			}
			midCrossingSum[i] = count;
		}

		return createSignalLoop(cleanData, [upper, lower, middle, midCrossingSum], (i) => {
			const up = upper[i];
			const dn = lower[i];
			const prevUp = upper[i - 1];
			const prevDn = lower[i - 1];
			const cc = midCrossingSum[i];
			if (up === null || dn === null || prevUp === null || prevDn === null || cc === null) return null;

			if (cc >= minCross && closes[i - 1] <= prevUp && closes[i] > up) {
				return createBuySignal(cleanData, i, `Keltner churn breakout bullish (${cc} crosses)`);
			}
			if (cc >= minCross && closes[i - 1] >= prevDn && closes[i] < dn) {
				return createSellSignal(cleanData, i, `Keltner churn breakout bearish (${cc} crosses)`);
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['keltnerPeriod', 'churnLookback', 'minCrossings'],
	},
};
