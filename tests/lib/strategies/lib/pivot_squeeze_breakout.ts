import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, detectPivotsWithDeviation } from '../strategy-helpers';
import { buildPercentileRank } from './price-action-statistics-core';

function normalizePivotSqueezeBreakoutParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		pivotDeviation: Math.max(0.1, Number(params.pivotDeviation ?? 2.0)),
		rankLookback: Math.max(10, Math.round(params.rankLookback ?? 100)),
		squeezePercentile: Math.max(0.01, Math.min(0.5, Number(params.squeezePercentile ?? 0.05))),
	};
}

export const pivot_squeeze_breakout: Strategy = {
	name: 'Pivot Squeeze Breakout',
	description: 'Quantifies structural range compression by measuring the distance between the last confirmed Pivot High and Pivot Low, entering when this distance hits a historical minimum.',
	defaultParams: {
		pivotDeviation: 2.0,
		rankLookback: 100,
		squeezePercentile: 0.05,
	},
	paramLabels: {
		pivotDeviation: 'Pivot Deviation',
		rankLookback: 'Rank Lookback',
		squeezePercentile: 'Squeeze Percentile',
	},
	normalizeParams: normalizePivotSqueezeBreakoutParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const np = normalizePivotSqueezeBreakoutParams(params);
		const deviation = np.pivotDeviation as number;
		const rankLb = np.rankLookback as number;
		const sqPct = np.squeezePercentile as number;

		if (cleanData.length < 10) return [];

		const closes = getCloses(cleanData);
		const pivots = detectPivotsWithDeviation(cleanData, deviation, 5);
		if (pivots.length < 2) return [];

		const lastPivotHighPrice = new Array(cleanData.length).fill(0);
		const lastPivotLowPrice = new Array(cleanData.length).fill(0);
		let lastHigh = 0;
		let lastLow = Infinity;

		for (let i = 0; i < cleanData.length; i++) {
			for (const p of pivots) {
				if (p.index <= i) {
					if (p.isHigh && p.price > lastHigh) lastHigh = p.price;
					if (!p.isHigh && p.price < lastLow) lastLow = p.price;
				}
			}
			lastPivotHighPrice[i] = lastHigh;
			lastPivotLowPrice[i] = lastLow;
		}

		const spread = lastPivotHighPrice.map((h, i) => {
			if (h === 0 || lastPivotLowPrice[i] === Infinity) return 0;
			return h - lastPivotLowPrice[i];
		});

		const spreadRank = buildPercentileRank(spread, rankLb);

		const signals = [];
		for (let i = rankLb; i < cleanData.length; i++) {
			const rank = spreadRank[i];
			if (rank === null) continue;
			if (lastPivotHighPrice[i] === 0 || lastPivotLowPrice[i] === Infinity) continue;

			if (rank < sqPct && closes[i - 1] <= lastPivotHighPrice[i - 1] && closes[i] > lastPivotHighPrice[i]) {
				signals.push(createBuySignal(cleanData, i, 'Pivot squeeze breakout bullish'));
			}
			if (rank < sqPct && closes[i - 1] >= lastPivotLowPrice[i - 1] && closes[i] < lastPivotLowPrice[i]) {
				signals.push(createSellSignal(cleanData, i, 'Pivot squeeze breakout bearish'));
			}
		}

		return signals;
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['pivotDeviation', 'rankLookback', 'squeezePercentile'],
	},
};
