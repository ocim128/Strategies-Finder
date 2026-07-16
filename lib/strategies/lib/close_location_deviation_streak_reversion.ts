import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		locationBoundary: Math.max(0.5, Math.min(1, Number(params.locationBoundary ?? 0.88))),
		streakThreshold: Math.max(1, Math.round(Number(params.streakThreshold ?? 3))),
	};
}

export const close_location_deviation_streak_reversion: Strategy = {
	name: "Close Location Deviation Streak Reversion",
	description: "Fades extreme close location values when the close location reverts back to center.",
	defaultParams: {
		locationBoundary: 0.88,
		streakThreshold: 3,
	},
	paramLabels: {
		locationBoundary: "Location Boundary",
		streakThreshold: "Streak Threshold",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		const locationBoundary = p.locationBoundary as number;
		const streakThreshold = p.streakThreshold as number;

		if (cleanData.length < streakThreshold + 2) return [];

		const closeLocation = buildCloseLocationSeries(cleanData);

		// Compute close location streaks
		const flagsAbove = new Array(cleanData.length).fill(0);
		const flagsBelow = new Array(cleanData.length).fill(0);
		for (let j = 0; j < cleanData.length; j++) {
			const loc = closeLocation[j];
			if (loc > locationBoundary) {
				flagsAbove[j] = 1;
			} else if (loc < (1 - locationBoundary)) {
				flagsBelow[j] = -1;
			}
		}
		const aboveStreaks = buildStreakCount(flagsAbove);
		const belowStreaks = buildStreakCount(flagsBelow);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < streakThreshold + 1) return null;

			// Buy: close location below (1 - locationBoundary) for streakThreshold consecutive bars up to i-1,
			// and current closeLocation is above 0.5
			if (belowStreaks[i - 1] <= -streakThreshold && closeLocation[i] > 0.5) {
				return createBuySignal(cleanData, i, `Close location below boundary for ${Math.abs(belowStreaks[i - 1])} bars, reverted above 0.5`);
			}
			// Sell: close location above locationBoundary for streakThreshold consecutive bars up to i-1,
			// and current closeLocation is below 0.5
			if (aboveStreaks[i - 1] >= streakThreshold && closeLocation[i] < 0.5) {
				return createSellSignal(cleanData, i, `Close location above boundary for ${aboveStreaks[i - 1]} bars, reverted below 0.5`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["locationBoundary", "streakThreshold"],
	},
};
