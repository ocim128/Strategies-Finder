import { Strategy, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from '../strategy-helpers';
import { buildStreakCount, extractBarMetricSeries } from './price-action-statistics-core';

function normalizeDirectionalStreakGeometryFadeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		streakThreshold: Math.max(2, Math.round(params.streakThreshold ?? 6)),
		rejectionThreshold: Math.max(0.01, Math.min(0.5, Number(params.rejectionThreshold ?? 0.15))),
	};
}

export const directional_streak_geometry_fade: Strategy = {
	name: 'Directional Streak Geometry Fade',
	description: 'Fades highly persistent directional streaks only when the terminal bar of the streak prints a violently contrarian intra-bar geometry.',
	defaultParams: {
		streakThreshold: 6,
		rejectionThreshold: 0.15,
	},
	paramLabels: {
		streakThreshold: 'Streak Threshold',
		rejectionThreshold: 'Rejection Threshold',
	},
	normalizeParams: normalizeDirectionalStreakGeometryFadeParams,
	execute: (data, params) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeDirectionalStreakGeometryFadeParams(params);
		const streakThreshold = normalizedParams.streakThreshold as number;
		const rejectionThreshold = normalizedParams.rejectionThreshold as number;

		if (cleanData.length < streakThreshold + 1) return [];

		const closes = getCloses(cleanData);
		const directionFlags = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			if (i === 0) { directionFlags[i] = 0; continue; }
			if (closes[i] > closes[i - 1]) directionFlags[i] = 1;
			else if (closes[i] < closes[i - 1]) directionFlags[i] = -1;
		}

		const streaks = buildStreakCount(directionFlags);
		const closeLocation = extractBarMetricSeries(cleanData, 'closeLocation');

		return createSignalLoop(cleanData, [], (i) => {
			const streak = streaks[i];
			const cl = closeLocation[i];

			if (streak <= -streakThreshold && cl > (1.0 - rejectionThreshold)) {
				return createBuySignal(cleanData, i, `Down-streak ${Math.abs(streak)} with bullish close location ${cl.toFixed(2)}`);
			}
			if (streak >= streakThreshold && cl < rejectionThreshold) {
				return createSellSignal(cleanData, i, `Up-streak ${streak} with bearish close location ${cl.toFixed(2)}`);
			}

			return null;
		});
	},
	metadata: {
		role: 'entry',
		direction: 'both',
		walkForwardParams: ['streakThreshold', 'rejectionThreshold'],
	},
};
