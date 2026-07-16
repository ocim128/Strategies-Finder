import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		pressureThreshold: Math.max(0, Math.min(1, Number(params.pressureThreshold ?? 0.6))),
		streakThreshold: Math.max(1, Math.round(Number(params.streakThreshold ?? 4))),
	};
}

export const initiative_pressure_streak_fade: Strategy = {
	name: "Initiative Pressure Streak Fade",
	description: "Fades consecutive bars showing extreme initiative pressure above a relative threshold.",
	defaultParams: {
		pressureThreshold: 0.6,
		streakThreshold: 4,
	},
	paramLabels: {
		pressureThreshold: "Pressure Threshold",
		streakThreshold: "Streak Threshold",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		const pressureThreshold = p.pressureThreshold as number;
		const streakThreshold = p.streakThreshold as number;

		// We use a fixed lookback of 10 for the volume average in buildInitiativePressureSeries
		const minLookback = 10;
		if (cleanData.length < Math.max(minLookback, streakThreshold + 1)) return [];

		const pressure = buildInitiativePressureSeries(cleanData, minLookback);

		// Compute streaks
		const upperFlags = new Array(cleanData.length).fill(0);
		const lowerFlags = new Array(cleanData.length).fill(0);
		for (let j = 0; j < cleanData.length; j++) {
			const pres = pressure[j];
			if (pres !== null) {
				if (pres > pressureThreshold) {
					upperFlags[j] = 1;
				} else if (pres < -pressureThreshold) {
					lowerFlags[j] = -1;
				}
			}
		}
		const upperStreaks = buildStreakCount(upperFlags);
		const lowerStreaks = buildStreakCount(lowerFlags);

		return createSignalLoop(cleanData, [pressure], (i) => {
			if (i < streakThreshold) return null;

			if (lowerStreaks[i] <= -streakThreshold) {
				return createBuySignal(cleanData, i, `Bearish initiative pressure streak of ${Math.abs(lowerStreaks[i])} bars (exhaustion)`);
			}
			if (upperStreaks[i] >= streakThreshold) {
				return createSellSignal(cleanData, i, `Bullish initiative pressure streak of ${upperStreaks[i]} bars (exhaustion)`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["pressureThreshold", "streakThreshold"],
	},
};
