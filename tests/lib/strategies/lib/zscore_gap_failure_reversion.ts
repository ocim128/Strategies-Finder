import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from '../strategy-helpers';
import { extractBarMetricSeries, buildRollingZScore } from './price-action-statistics-core';

function normalizeZscoreGapFailureReversionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(5, Math.round(params.lookback ?? 50)),
		gapZScoreExtreme: Math.max(0.5, Number(params.gapZScoreExtreme ?? 2.5)),
	};
}

export const zscore_gap_failure_reversion: Strategy = {
	name: 'Z-Score Gap Failure Reversion',
	description: 'Scores the magnitude of the opening gap relative to historical gap variance, fading statistically impossible gaps that fail to hold their intra-bar momentum.',
	defaultParams: {
		lookback: 50,
		gapZScoreExtreme: 2.5,
	},
	paramLabels: {
		lookback: 'Lookback',
		gapZScoreExtreme: 'Gap Z-Score Extreme',
	},
	normalizeParams: normalizeZscoreGapFailureReversionParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeZscoreGapFailureReversionParams(params);
		const lookback = normalizedParams.lookback as number;
		const gapZThresh = normalizedParams.gapZScoreExtreme as number;

		if (cleanData.length < lookback + 1) return [];

		const gapPct = extractBarMetricSeries(cleanData, 'gapPct');
		const absGapPct = gapPct.map(v => Math.abs(v));
		const gapZscore = buildRollingZScore(absGapPct, lookback);

		return createSignalLoop(cleanData, [gapZscore], (i) => {
			const z = gapZscore[i];
			if (z === null) return null;

			const isGapDown = gapPct[i] < 0;
			const isBullishBar = cleanData[i].close > cleanData[i].open;

			if (isGapDown && z > gapZThresh && isBullishBar) {
				return createBuySignal(cleanData, i, `Gap failure reversion bullish (z=${z.toFixed(2)})`);
			}

			const isGapUp = gapPct[i] > 0;
			const isBearishBar = cleanData[i].close < cleanData[i].open;

			if (isGapUp && z > gapZThresh && isBearishBar) {
				return createSellSignal(cleanData, i, `Gap failure reversion bearish (z=${z.toFixed(2)})`);
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['lookback', 'gapZScoreExtreme'],
	},
};
