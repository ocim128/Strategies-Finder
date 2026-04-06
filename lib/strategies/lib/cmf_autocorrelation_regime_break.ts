import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows, getVolumes } from '../strategy-helpers';
import { buildRollingAutoCorrelation, buildRollingZScore } from './price-action-statistics-core';
import { calculateCMF } from '../indicators';

function normalizeCmfAutocorrelationRegimeBreakParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(5, Math.round(params.lookback ?? 30)),
		autoCorrDropThreshold: Math.max(-1.0, Math.min(1.0, Number(params.autoCorrDropThreshold ?? 0.1))),
	};
}

export const cmf_autocorrelation_regime_break: Strategy = {
	name: 'CMF Autocorrelation Regime Break',
	description: 'Detects the exact moment historical money flow persistence collapses, entering heavily on the simultaneous price z-score extreme.',
	defaultParams: {
		lookback: 30,
		autoCorrDropThreshold: 0.1,
	},
	paramLabels: {
		lookback: 'Lookback',
		autoCorrDropThreshold: 'Autocorrelation Drop Threshold',
	},
	normalizeParams: normalizeCmfAutocorrelationRegimeBreakParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeCmfAutocorrelationRegimeBreakParams(params);
		const lookback = normalizedParams.lookback as number;
		const autoCorrThresh = normalizedParams.autoCorrDropThreshold as number;

		if (cleanData.length < lookback * 2) return [];

		const closes = getCloses(cleanData);
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const volumes = getVolumes(cleanData);

		const cmf = calculateCMF(highs, lows, closes, volumes, lookback);
		const cmfNonNull = cmf.map(v => v !== null ? v as number : 0);
		const autoCorr = buildRollingAutoCorrelation(cmfNonNull, lookback);
		const priceZscore = buildRollingZScore(closes, lookback);

		return createSignalLoop(cleanData, [autoCorr, priceZscore], (i) => {
			const ac = autoCorr[i];
			const pz = priceZscore[i];
			if (ac === null || pz === null) return null;

			if (ac < autoCorrThresh && pz < -2.0) {
				return createBuySignal(cleanData, i, 'CMF autocorrelation regime break bullish');
			}
			if (ac < autoCorrThresh && pz > 2.0) {
				return createSellSignal(cleanData, i, 'CMF autocorrelation regime break bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['lookback', 'autoCorrDropThreshold'],
	},
};
