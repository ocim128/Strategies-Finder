import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from '../strategy-helpers';
import { extractBarMetricSeries } from './price-action-statistics-core';

function normalizeRunawayGapThrustParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		gapPctThreshold: Math.max(0.01, Number(params.gapPctThreshold ?? 1.0)),
		closeLocExtreme: Math.max(0.5, Math.min(1.0, Number(params.closeLocExtreme ?? 0.8))),
	};
}

export const runaway_gap_thrust: Strategy = {
	name: 'Runaway Gap Thrust',
	description: 'Buys massive opening gaps only when the gap bar itself closes heavily in the direction of the gap, proving conviction instead of exhaustion.',
	defaultParams: {
		gapPctThreshold: 1.0,
		closeLocExtreme: 0.8,
	},
	paramLabels: {
		gapPctThreshold: 'Gap % Threshold',
		closeLocExtreme: 'Close Location Extreme',
	},
	normalizeParams: normalizeRunawayGapThrustParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeRunawayGapThrustParams(params);
		const gapThresh = normalizedParams.gapPctThreshold as number;
		const clExtreme = normalizedParams.closeLocExtreme as number;

		if (cleanData.length < 2) return [];

		const gapPct = extractBarMetricSeries(cleanData, 'gapPct');
		const bodyDir = extractBarMetricSeries(cleanData, 'bodyDirection');
		const closeLoc = extractBarMetricSeries(cleanData, 'closeLocation');

		return createSignalLoop(cleanData, [], (i) => {
			const gap = gapPct[i] * 100;
			const bd = bodyDir[i];
			const cl = closeLoc[i];

			if (gap > gapThresh && bd === 1 && cl > clExtreme) {
				return createBuySignal(cleanData, i, `Runaway gap thrust bullish (${gap.toFixed(1)}%)`);
			}
			if (gap < -gapThresh && bd === -1 && cl < (1.0 - clExtreme)) {
				return createSellSignal(cleanData, i, `Runaway gap thrust bearish (${gap.toFixed(1)}%)`);
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['gapPctThreshold', 'closeLocExtreme'],
	},
};
