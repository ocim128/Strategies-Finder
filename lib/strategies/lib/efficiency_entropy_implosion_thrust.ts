import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from '../strategy-helpers';
import { buildEfficiencyRatio, buildRollingEntropy, extractBarMetricSeries } from './price-action-statistics-core';

function normalizeEfficiencyEntropyImplosionThrustParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(5, Math.round(params.lookback ?? 20)),
		erThreshold: Math.max(0.01, Math.min(1.0, Number(params.erThreshold ?? 0.15))),
		entropyThreshold: Math.max(0.1, Number(params.entropyThreshold ?? 2.5)),
	};
}

export const efficiency_entropy_implosion_thrust: Strategy = {
	name: 'Efficiency Entropy Implosion Thrust',
	description: 'Finds the exact intersection of perfectly random walk (Efficiency Ratio near 0) and total chaotic disorder (Entropy peaked), entering when price violently expands out of it.',
	defaultParams: {
		lookback: 20,
		erThreshold: 0.15,
		entropyThreshold: 2.5,
	},
	paramLabels: {
		lookback: 'Lookback',
		erThreshold: 'ER Threshold',
		entropyThreshold: 'Entropy Threshold',
	},
	normalizeParams: normalizeEfficiencyEntropyImplosionThrustParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeEfficiencyEntropyImplosionThrustParams(params);
		const lookback = normalizedParams.lookback as number;
		const erThresh = normalizedParams.erThreshold as number;
		const entropyThresh = normalizedParams.entropyThreshold as number;

		if (cleanData.length < lookback + 1) return [];

		const er = buildEfficiencyRatio(cleanData, lookback);
		const closeReturns = extractBarMetricSeries(cleanData, 'closeReturn');
		const entropy = buildRollingEntropy(closeReturns, lookback);
		const bodyPct = extractBarMetricSeries(cleanData, 'bodyPct');
		const bodyDirection = extractBarMetricSeries(cleanData, 'bodyDirection');

		return createSignalLoop(cleanData, [er, entropy], (i) => {
			const e = er[i];
			const ent = entropy[i];
			if (e === null || ent === null) return null;

			if (e < erThresh && ent > entropyThresh && bodyPct[i] > 0.6 && bodyDirection[i] === 1) {
				return createBuySignal(cleanData, i, 'Efficiency entropy implosion thrust bullish');
			}
			if (e < erThresh && ent > entropyThresh && bodyPct[i] > 0.6 && bodyDirection[i] === -1) {
				return createSellSignal(cleanData, i, 'Efficiency entropy implosion thrust bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['lookback', 'erThreshold', 'entropyThreshold'],
	},
};
