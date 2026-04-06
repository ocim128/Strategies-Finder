import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { buildDualTimeframeRatio } from './price-action-statistics-core';
import { calculateCCI } from '../indicators';
import { calculateSMA } from '../indicators';

function normalizeDualTimeframeCciSnapParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		fastWindow: Math.max(2, Math.round(params.fastWindow ?? 5)),
		slowWindow: Math.max(3, Math.round(params.slowWindow ?? 20)),
		cciExtreme: Number(params.cciExtreme ?? -150),
	};
}

export const dual_timeframe_cci_snap: Strategy = {
	name: 'Dual Timeframe CCI Snap',
	description: 'Requires the asset to be structurally gaining on a higher timeframe, then enters on chaotic micro-timeframe pullbacks exiting extreme oversold conditions.',
	defaultParams: {
		fastWindow: 5,
		slowWindow: 20,
		cciExtreme: -150,
	},
	paramLabels: {
		fastWindow: 'Fast Window',
		slowWindow: 'Slow Window',
		cciExtreme: 'CCI Extreme',
	},
	normalizeParams: normalizeDualTimeframeCciSnapParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeDualTimeframeCciSnapParams(params);
		const fastWindow = normalizedParams.fastWindow as number;
		const slowWindow = normalizedParams.slowWindow as number;
		const cciExtreme = normalizedParams.cciExtreme as number;

		if (cleanData.length < slowWindow + 20) return [];

		const closes = getCloses(cleanData);
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);

		const dtfRatio = buildDualTimeframeRatio(closes, fastWindow, slowWindow, calculateSMA);
		const cci = calculateCCI(highs, lows, closes, 20);

		return createSignalLoop(cleanData, [dtfRatio, cci], (i) => {
			const ratio = dtfRatio[i];
			const c = cci[i];
			const prevC = cci[i - 1];
			if (ratio === null || c === null || prevC === null) return null;

			if (ratio > 1.0 && prevC <= cciExtreme && c > cciExtreme) {
				return createBuySignal(cleanData, i, 'Dual TF CCI snap bullish');
			}
			const sellExtreme = Math.abs(cciExtreme);
			if (ratio < 1.0 && prevC >= sellExtreme && c < sellExtreme) {
				return createSellSignal(cleanData, i, 'Dual TF CCI snap bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['fastWindow', 'slowWindow', 'cciExtreme'],
	},
};
