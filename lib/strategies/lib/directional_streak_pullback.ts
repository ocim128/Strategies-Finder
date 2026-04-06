import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { buildStreakCount } from './price-action-statistics-core';

function normalizeDirectionalStreakPullbackParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		macroStreak: Math.max(2, Math.round(params.macroStreak ?? 4)),
		microPullback: Math.max(1, Math.round(params.microPullback ?? 2)),
	};
}

export const directional_streak_pullback: Strategy = {
	name: 'Directional Streak Pullback',
	description: 'Identifies a strong directional macro streak (N bars), followed immediately by a sharp micro pullback (M bars), entering on the resumption of the primary streak.',
	defaultParams: {
		macroStreak: 4,
		microPullback: 2,
	},
	paramLabels: {
		macroStreak: 'Macro Streak',
		microPullback: 'Micro Pullback',
	},
	normalizeParams: normalizeDirectionalStreakPullbackParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeDirectionalStreakPullbackParams(params);
		const macroLen = normalizedParams.macroStreak as number;
		const microLen = normalizedParams.microPullback as number;

		if (cleanData.length < macroLen + microLen + 1) return [];

		const closes = getCloses(cleanData);
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);

		const dirFlags = new Array(cleanData.length).fill(0);
		for (let i = 1; i < cleanData.length; i++) {
			if (closes[i] > closes[i - 1]) dirFlags[i] = 1;
			else if (closes[i] < closes[i - 1]) dirFlags[i] = -1;
		}
		const streaks = buildStreakCount(dirFlags);

		return createSignalLoop(cleanData, [], (i) => {
			const anchor = i - microLen;
			if (anchor < 1) return null;

			const anchorStreak = streaks[anchor];
			if (anchorStreak === undefined) return null;

			for (let j = anchor + 1; j <= i; j++) {
				if (dirFlags[j] === 0) return null;
			}

			if (anchorStreak >= macroLen) {
				let allDown = true;
				for (let j = anchor + 1; j <= i; j++) {
					if (dirFlags[j] >= 0) { allDown = false; break; }
				}
				const pullbackLen = i - anchor;
				if (allDown && pullbackLen === microLen && closes[i] > highs[i - 1]) {
					return createBuySignal(cleanData, i, `Directional streak pullback bullish (${anchorStreak}u/${pullbackLen}d)`);
				}
			}

			if (anchorStreak <= -macroLen) {
				let allUp = true;
				for (let j = anchor + 1; j <= i; j++) {
					if (dirFlags[j] <= 0) { allUp = false; break; }
				}
				const pullbackLen = i - anchor;
				if (allUp && pullbackLen === microLen && closes[i] < lows[i - 1]) {
					return createSellSignal(cleanData, i, `Directional streak pullback bearish (${Math.abs(anchorStreak)}d/${pullbackLen}u)`);
				}
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['macroStreak', 'microPullback'],
	},
};
