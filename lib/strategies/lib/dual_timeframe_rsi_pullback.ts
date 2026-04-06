import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from '../strategy-helpers';
import { calculateRSI } from '../indicators';

function normalizeDualTimeframeRsiPullbackParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		fastRsiPeriod: Math.max(2, Math.round(params.fastRsiPeriod ?? 5)),
		slowRsiPeriod: Math.max(2, Math.round(params.slowRsiPeriod ?? 14)),
		extremeLevel: Math.max(5, Math.min(45, Number(params.extremeLevel ?? 30))),
	};
}

export const dual_timeframe_rsi_pullback: Strategy = {
	name: 'Dual Timeframe RSI Pullback',
	description: 'Ensures the macro timeframe is in a confirmed trend using RSI, and buys micro pullbacks when the fast RSI reaches the opposite extreme.',
	defaultParams: {
		fastRsiPeriod: 5,
		slowRsiPeriod: 14,
		extremeLevel: 30,
	},
	paramLabels: {
		fastRsiPeriod: 'Fast RSI Period',
		slowRsiPeriod: 'Slow RSI Period',
		extremeLevel: 'Extreme Level',
	},
	normalizeParams: normalizeDualTimeframeRsiPullbackParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeDualTimeframeRsiPullbackParams(params);
		const fastPeriod = normalizedParams.fastRsiPeriod as number;
		const slowPeriod = normalizedParams.slowRsiPeriod as number;
		const extremeLevel = normalizedParams.extremeLevel as number;

		if (cleanData.length < Math.max(fastPeriod, slowPeriod) + 2) return [];

		const closes = getCloses(cleanData);
		const fastRsi = calculateRSI(closes, fastPeriod);
		const slowRsi = calculateRSI(closes, slowPeriod);

		return createSignalLoop(cleanData, [fastRsi, slowRsi], (i) => {
			const fast = fastRsi[i];
			const slow = slowRsi[i];
			if (fast === null || slow === null) return null;

			if (slow > 50 && fast < extremeLevel) {
				return createBuySignal(cleanData, i, `Dual TF RSI pullback bullish (slow=${slow.toFixed(0)}, fast=${fast.toFixed(0)})`);
			}
			if (slow < 50 && fast > (100 - extremeLevel)) {
				return createSellSignal(cleanData, i, `Dual TF RSI pullback bearish (slow=${slow.toFixed(0)}, fast=${fast.toFixed(0)})`);
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['fastRsiPeriod', 'slowRsiPeriod', 'extremeLevel'],
	},
};
