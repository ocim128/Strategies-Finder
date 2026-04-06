import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { buildThresholdCrossingCount } from './price-action-statistics-core';
import { calculateCCI } from '../indicators';

function normalizeCciChurnBreakoutParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		cciPeriod: Math.max(2, Math.round(params.cciPeriod ?? 14)),
		churnLookback: Math.max(2, Math.round(params.churnLookback ?? 20)),
		churnCrossings: Math.max(1, Math.round(params.churnCrossings ?? 5)),
	};
}

export const cci_churn_breakout: Strategy = {
	name: 'CCI Churn Breakout',
	description: 'Quantifies chaotic sideways chop by counting extreme numbers of zero-line crossings in CCI, treating the eventual breakout as structurally highly significant.',
	defaultParams: {
		cciPeriod: 14,
		churnLookback: 20,
		churnCrossings: 5,
	},
	paramLabels: {
		cciPeriod: 'CCI Period',
		churnLookback: 'Churn Lookback',
		churnCrossings: 'Churn Crossings',
	},
	normalizeParams: normalizeCciChurnBreakoutParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeCciChurnBreakoutParams(params);
		const cciPeriod = normalizedParams.cciPeriod as number;
		const churnLookback = normalizedParams.churnLookback as number;
		const churnCrossings = normalizedParams.churnCrossings as number;

		if (cleanData.length < cciPeriod + churnLookback) return [];

		const closes = getCloses(cleanData);
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);

		const cci = calculateCCI(highs, lows, closes, cciPeriod);
		const cciNonNull = cci.map(v => v !== null ? v as number : 0);
		const crossingCount = buildThresholdCrossingCount(cciNonNull, churnLookback, 0);

		return createSignalLoop(cleanData, [cci, crossingCount], (i) => {
			const c = cci[i];
			const cc = crossingCount[i];
			if (c === null || cc === null) return null;

			const inChurn = cc >= churnCrossings;

			if (inChurn && c > 100) {
				return createBuySignal(cleanData, i, `CCI churn breakout bullish (${cc} crossings)`);
			}
			if (inChurn && c < -100) {
				return createSellSignal(cleanData, i, `CCI churn breakout bearish (${cc} crossings)`);
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['cciPeriod', 'churnLookback', 'churnCrossings'],
	},
};
