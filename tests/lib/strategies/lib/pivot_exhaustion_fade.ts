import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows, detectPivotsWithDeviation } from '../strategy-helpers';
import { extractBarMetricSeries } from './price-action-statistics-core';

function normalizePivotExhaustionFadeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		pivotDeviation: Math.max(0.1, Number(params.pivotDeviation ?? 2.0)),
		closeLocExtreme: Math.max(0.05, Math.min(0.5, Number(params.closeLocExtreme ?? 0.2))),
	};
}

export const pivot_exhaustion_fade: Strategy = {
	name: 'Pivot Exhaustion Fade',
	description: 'Fades structural pivot breaks when the price pierces the pivot level but the bar heavily rejects the level intra-bar, creating a classic liquidity sweep.',
	defaultParams: {
		pivotDeviation: 2.0,
		closeLocExtreme: 0.2,
	},
	paramLabels: {
		pivotDeviation: 'Pivot Deviation',
		closeLocExtreme: 'Close Location Extreme',
	},
	normalizeParams: normalizePivotExhaustionFadeParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizePivotExhaustionFadeParams(params);
		const deviation = normalizedParams.pivotDeviation as number;
		const clExtreme = normalizedParams.closeLocExtreme as number;

		if (cleanData.length < 10) return [];

		const pivots = detectPivotsWithDeviation(cleanData, deviation, 5);
		if (pivots.length < 2) return [];

		const closes = getCloses(cleanData);
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const closeLoc = extractBarMetricSeries(cleanData, 'closeLocation');

		let lastPivotHigh = -1;
		let lastPivotHighPrice = 0;
		let lastPivotLow = -1;
		let lastPivotLowPrice = Infinity;

		const signals = [];

		for (const p of pivots) {
			if (p.isHigh) {
				lastPivotHigh = p.index;
				lastPivotHighPrice = p.price;
			} else {
				lastPivotLow = p.index;
				lastPivotLowPrice = p.price;
			}

			const start = Math.max(p.index + 1, lastPivotHigh >= 0 ? lastPivotHigh + 1 : 0, lastPivotLow >= 0 ? lastPivotLow + 1 : 0);
			if (lastPivotHigh < 0 || lastPivotLow < 0) continue;

			for (let i = start; i < cleanData.length; i++) {
				if (i <= p.index) continue;
				if (i > p.index + 1) break;

				if (lows[i] < lastPivotLowPrice && closes[i] > lastPivotLowPrice && closeLoc[i] > (1.0 - clExtreme)) {
					signals.push(createBuySignal(cleanData, i, 'Pivot exhaustion fade bullish'));
				}
				if (highs[i] > lastPivotHighPrice && closes[i] < lastPivotHighPrice && closeLoc[i] < clExtreme) {
					signals.push(createSellSignal(cleanData, i, 'Pivot exhaustion fade bearish'));
				}
			}
		}

		return signals;
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['pivotDeviation', 'closeLocExtreme'],
	},
};
