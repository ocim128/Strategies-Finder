import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from '../strategy-helpers';
import { buildPercentileRank } from './price-action-statistics-core';
import { calculateBollingerBands } from '../indicators';

function normalizeBollingerBandwidthImplosionSnapParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		bbPeriod: Math.max(5, Math.round(params.bbPeriod ?? 20)),
		bandwidthPercentile: Math.max(0.01, Math.min(0.5, Number(params.bandwidthPercentile ?? 0.05))),
	};
}

export const bollinger_bandwidth_implosion_snap: Strategy = {
	name: 'Bollinger Bandwidth Implosion Snap',
	description: 'Measures the statistical compression of Bollinger Bands as a percentile rank, entering on the first band touch when the bands are in a historical choke-point.',
	defaultParams: {
		bbPeriod: 20,
		bandwidthPercentile: 0.05,
	},
	paramLabels: {
		bbPeriod: 'BB Period',
		bandwidthPercentile: 'Bandwidth Percentile',
	},
	normalizeParams: normalizeBollingerBandwidthImplosionSnapParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeBollingerBandwidthImplosionSnapParams(params);
		const bbPeriod = normalizedParams.bbPeriod as number;
		const bwPctThreshold = normalizedParams.bandwidthPercentile as number;

		if (cleanData.length < bbPeriod * 2) return [];

		const closes = getCloses(cleanData);
		const { upper, lower } = calculateBollingerBands(closes, bbPeriod, 2);

		const bandwidth: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			const up = upper[i];
			const dn = lower[i];
			if (up !== null && dn !== null) {
				bandwidth[i] = up - dn;
			}
		}

		const bwPercentile = buildPercentileRank(bandwidth, bbPeriod);

		return createSignalLoop(cleanData, [upper, lower, bwPercentile], (i) => {
			const pct = bwPercentile[i];
			const up = upper[i];
			const dn = lower[i];
			const prevUp = upper[i - 1];
			const prevDn = lower[i - 1];
			if (pct === null || up === null || dn === null || prevUp === null || prevDn === null) return null;

			if (pct < bwPctThreshold && closes[i] > up && closes[i - 1] <= prevUp) {
				return createBuySignal(cleanData, i, 'BB implosion snap bullish');
			}
			if (pct < bwPctThreshold && closes[i] < dn && closes[i - 1] >= prevDn) {
				return createSellSignal(cleanData, i, 'BB implosion snap bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['bbPeriod', 'bandwidthPercentile'],
	},
};
