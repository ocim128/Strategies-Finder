import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { buildRateOfChange } from './price-action-statistics-core';
import { buildTrailingHighLow } from './price-action-frequency-core';
import { calculateATR } from '../indicators';

function normalizeAtrAccelerationBreakoutParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(5, Math.round(params.lookback ?? 20)),
		atrPeriod: Math.max(2, Math.round(params.atrPeriod ?? 14)),
		atrAccelThreshold: Math.max(0, Number(params.atrAccelThreshold ?? 2.0)),
	};
}

export const atr_acceleration_breakout: Strategy = {
	name: 'ATR Acceleration Breakout',
	description: 'Validates classic trailing extreme breakouts by mandating that the ATR itself is in an accelerating uptrend, ensuring expanding liquidity supports the move.',
	defaultParams: {
		lookback: 20,
		atrPeriod: 14,
		atrAccelThreshold: 2.0,
	},
	paramLabels: {
		lookback: 'Lookback',
		atrPeriod: 'ATR Period',
		atrAccelThreshold: 'ATR Accel Threshold',
	},
	normalizeParams: normalizeAtrAccelerationBreakoutParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeAtrAccelerationBreakoutParams(params);
		const lookback = np.lookback as number;
		const atrPeriod = np.atrPeriod as number;
		const accelThresh = np.atrAccelThreshold as number;

		if (cleanData.length < lookback + atrPeriod + 6) return [];

		const closes = getCloses(cleanData);
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);

		const { highest, lowest } = buildTrailingHighLow(cleanData, lookback);
		const atr = calculateATR(highs, lows, closes, atrPeriod);
		const atrNonNull = atr.map(v => v ?? 0);
		const atrRoc = buildRateOfChange(atrNonNull, 5);

		return createSignalLoop(cleanData, [highest, lowest, atrRoc], (i) => {
			const hi = highest[i - 1];
			const lo = lowest[i - 1];
			const roc = atrRoc[i];
			if (hi === null || lo === null || roc === null) return null;

			if (closes[i] > hi && roc > accelThresh) {
				return createBuySignal(cleanData, i, 'ATR acceleration breakout bullish');
			}
			if (closes[i] < lo && roc > accelThresh) {
				return createSellSignal(cleanData, i, 'ATR acceleration breakout bearish');
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['lookback', 'atrPeriod', 'atrAccelThreshold'],
	},
};
