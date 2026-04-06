import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from '../strategy-helpers';
import { extractBarMetricSeries } from './price-action-statistics-core';

function normalizeOpeningGapRejectionFadeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		gapThresholdPct: Math.max(0.01, Number(params.gapThresholdPct ?? 0.5)),
	};
}

export const opening_gap_rejection_fade: Strategy = {
	name: 'Opening Gap Rejection Fade',
	description: 'Fades significant opening gaps that immediately reject their gap direction, anticipating a structural fill of the gap.',
	defaultParams: {
		gapThresholdPct: 0.5,
	},
	paramLabels: {
		gapThresholdPct: 'Gap Threshold %',
	},
	normalizeParams: normalizeOpeningGapRejectionFadeParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeOpeningGapRejectionFadeParams(params);
		const gapThresh = normalizedParams.gapThresholdPct as number;

		if (cleanData.length < 2) return [];

		const gapPct = extractBarMetricSeries(cleanData, 'gapPct');

		return createSignalLoop(cleanData, [], (i) => {
			const gap = gapPct[i] * 100;

			if (gap < -gapThresh && cleanData[i].close > cleanData[i].open) {
				return createBuySignal(cleanData, i, `Gap down rejection fade (${gap.toFixed(2)}%)`);
			}
			if (gap > gapThresh && cleanData[i].close < cleanData[i].open) {
				return createSellSignal(cleanData, i, `Gap up rejection fade (${gap.toFixed(2)}%)`);
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['gapThresholdPct'],
	},
};
