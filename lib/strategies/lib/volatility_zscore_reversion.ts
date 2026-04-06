import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { buildRollingZScore, buildPercentileRank } from './price-action-statistics-core';
import { calculateATR } from '../indicators';

function normalizeVolatilityZscoreReversionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		zscoreLookback: Math.max(5, Math.round(params.zscoreLookback ?? 40)),
		atrRankLookback: Math.max(10, Math.round(params.atrRankLookback ?? 100)),
		priceZScoreExtreme: Math.max(0.5, Number(params.priceZScoreExtreme ?? 2.5)),
	};
}

export const volatility_zscore_reversion: Strategy = {
	name: 'Volatility Z-Score Reversion',
	description: 'Fades severe price dislocations that occur strictly during mathematically quantified low-volatility regimes, trapping thin-book liquidity anomalies.',
	defaultParams: {
		zscoreLookback: 40,
		atrRankLookback: 100,
		priceZScoreExtreme: 2.5,
	},
	paramLabels: {
		zscoreLookback: 'Z-Score Lookback',
		atrRankLookback: 'ATR Rank Lookback',
		priceZScoreExtreme: 'Price Z-Score Extreme',
	},
	normalizeParams: normalizeVolatilityZscoreReversionParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeVolatilityZscoreReversionParams(params);
		const zsLookback = np.zscoreLookback as number;
		const atrRankLb = np.atrRankLookback as number;
		const zsExtreme = np.priceZScoreExtreme as number;

		if (cleanData.length < Math.max(zsLookback, atrRankLb) + 1) return [];

		const closes = getCloses(cleanData);
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);

		const priceZscore = buildRollingZScore(closes, zsLookback);
		const atr = calculateATR(highs, lows, closes, 14);
		const atrNonNull = atr.map(v => v ?? 0);
		const atrPctRank = buildPercentileRank(atrNonNull, atrRankLb);

		return createSignalLoop(cleanData, [priceZscore, atrPctRank], (i) => {
			const pz = priceZscore[i];
			const ap = atrPctRank[i];
			if (pz === null || ap === null) return null;

			if (pz < -zsExtreme && ap < 0.20 && cleanData[i].close > cleanData[i].open) {
				return createBuySignal(cleanData, i, 'Volatility z-score reversion bullish');
			}
			if (pz > zsExtreme && ap < 0.20 && cleanData[i].close < cleanData[i].open) {
				return createSellSignal(cleanData, i, 'Volatility z-score reversion bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['zscoreLookback', 'atrRankLookback', 'priceZScoreExtreme'],
	},
};
