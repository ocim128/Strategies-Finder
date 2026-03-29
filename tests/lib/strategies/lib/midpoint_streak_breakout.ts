import { Strategy, StrategyParams, OHLCVData } from "../../types/strategies";
import { createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";

interface MidpointStreakBreakoutParams extends StrategyParams {
	maLookback: number;
	streakThreshold: number;
}

function normalizeMidpointStreakBreakoutParams(params: StrategyParams): StrategyParams {
	const p = params as MidpointStreakBreakoutParams;
	return {
		maLookback: Math.max(5, Math.round(p.maLookback ?? 20)),
		streakThreshold: Math.max(1, Math.round(p.streakThreshold ?? 3)),
	};
}

export const midpoint_streak_breakout: Strategy = {
	name: "Midpoint Streak Breakout",
	description: "When bar midpoints cross a threshold with directional persistence, momentum is established. Enter in direction.",
	defaultParams: {
		maLookback: 20,
		streakThreshold: 3,
	},
	paramLabels: {
		maLookback: "MA Lookback",
		streakThreshold: "Streak Threshold",
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["maLookback", "streakThreshold"],
	},
	normalizeParams: normalizeMidpointStreakBreakoutParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const p = normalizeMidpointStreakBreakoutParams(params) as MidpointStreakBreakoutParams;
		const cleanData = ensureCleanData(data);

		// Calculate midpoints
		const midpoints: number[] = [];
		for (let i = 0; i < cleanData.length; i++) {
			midpoints.push((cleanData[i].high + cleanData[i].low) / 2);
		}

		const midpointMA = buildRollingAverage(midpoints, p.maLookback);

		// Track streaks of midpoints on same side of MA
		const aboveStreaks: (number | null)[] = [];
		const belowStreaks: (number | null)[] = [];
		let currentAboveStreak = 0;
		let currentBelowStreak = 0;

		for (let i = 0; i < cleanData.length; i++) {
			const midpoint = midpoints[i];
			const ma = midpointMA[i];

			if (ma === null) {
				currentAboveStreak = 0;
				currentBelowStreak = 0;
				aboveStreaks.push(null);
				belowStreaks.push(null);
				continue;
			}

			const isAbove = midpoint > ma;
			const isBelow = midpoint < ma;

			if (isAbove) {
				currentAboveStreak++;
				currentBelowStreak = 0;
			} else if (isBelow) {
				currentBelowStreak++;
				currentAboveStreak = 0;
			} else {
				currentAboveStreak = 0;
				currentBelowStreak = 0;
			}

			aboveStreaks.push(currentAboveStreak);
			belowStreaks.push(currentBelowStreak);
		}

		return createSignalLoop(cleanData, [aboveStreaks, belowStreaks, midpoints, midpointMA], (i) => {
			const aboveStreak = aboveStreaks[i];
			const belowStreak = belowStreaks[i];
			const ma = midpointMA[i];

			if (aboveStreak === null || belowStreak === null || ma === null) {
				return null;
			}

			const bar = cleanData[i];

			// Buy: Midpoint remains above MA for streakThreshold consecutive bars
			if (aboveStreak >= p.streakThreshold) {
				return { type: 'buy', time: bar.time, price: bar.close, reason: 'Midpoint streak breakout - above MA' };
			}

			// Sell: Midpoint remains below MA for streakThreshold consecutive bars
			if (belowStreak >= p.streakThreshold) {
				return { type: 'sell', time: bar.time, price: bar.close, reason: 'Midpoint streak breakout - below MA' };
			}

			return null;
		});
	},
};
