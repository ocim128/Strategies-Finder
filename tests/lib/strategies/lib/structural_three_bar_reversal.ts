import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from '../strategy-helpers';
import { extractBarMetricSeries } from './price-action-statistics-core';

function normalizeStructuralThreeBarReversalParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		thrustBodyPct: Math.max(0.1, Math.min(1.0, Number(params.thrustBodyPct ?? 0.7))),
		dojiBodyPct: Math.max(0.01, Math.min(0.5, Number(params.dojiBodyPct ?? 0.25))),
	};
}

export const structural_three_bar_reversal: Strategy = {
	name: 'Structural Three Bar Reversal',
	description: 'A purely geometric abstraction of morning/evening stars. Identifies momentum, followed by perfect equilibrium (doji), followed by violent structural rejection.',
	defaultParams: {
		thrustBodyPct: 0.7,
		dojiBodyPct: 0.25,
	},
	paramLabels: {
		thrustBodyPct: 'Thrust Body %',
		dojiBodyPct: 'Doji Body %',
	},
	normalizeParams: normalizeStructuralThreeBarReversalParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeStructuralThreeBarReversalParams(params);
		const thrustBp = normalizedParams.thrustBodyPct as number;
		const dojiBp = normalizedParams.dojiBodyPct as number;

		if (cleanData.length < 3) return [];

		const bodyPct = extractBarMetricSeries(cleanData, 'bodyPct');
		const bodyDir = extractBarMetricSeries(cleanData, 'bodyDirection');

		return createSignalLoop(cleanData, [], (i) => {
			if (i < 2) return null;

			const bp0 = bodyPct[i - 2];
			const bp1 = bodyPct[i - 1];
			const bp2 = bodyPct[i];
			const bd0 = bodyDir[i - 2];
			const bd2 = bodyDir[i];

			if (bd0 === -1 && bp0 > thrustBp && bp1 < dojiBp && bd2 === 1 && bp2 > thrustBp) {
				return createBuySignal(cleanData, i, 'Structural three bar reversal bullish');
			}
			if (bd0 === 1 && bp0 > thrustBp && bp1 < dojiBp && bd2 === -1 && bp2 > thrustBp) {
				return createSellSignal(cleanData, i, 'Structural three bar reversal bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['thrustBodyPct', 'dojiBodyPct'],
	},
};
