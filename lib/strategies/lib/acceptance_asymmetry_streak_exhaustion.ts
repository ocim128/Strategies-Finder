import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildStreakCount, buildEfficiencyRatio } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	acceptance: number[];
	erByStreak: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		acceptanceThreshold: Math.max(0, Math.min(1, Number(params.acceptanceThreshold ?? 0.75))),
		streakThreshold: Math.max(2, Math.round(Number(params.streakThreshold ?? 3))),
	};
}

export const acceptance_asymmetry_streak_exhaustion: Strategy = {
	name: "Acceptance Asymmetry Streak Exhaustion",
	description: "Fades consecutive close acceptance streaks that show poor efficiency ratio displacement.",
	defaultParams: {
		acceptanceThreshold: 0.75,
		streakThreshold: 3,
	},
	paramLabels: {
		acceptanceThreshold: "Acceptance Threshold",
		streakThreshold: "Streak Threshold",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data,
		acceptance: buildCloseAcceptanceSeries(data),
		erByStreak: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const acceptanceThreshold = p.acceptanceThreshold as number;
		const streakThreshold = p.streakThreshold as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		if (cleanData.length < streakThreshold + 2) return [];

		const acceptance = prepared?.acceptance ?? buildCloseAcceptanceSeries(cleanData);
		const erByStreak = prepared?.erByStreak ?? new Map<number, (number | null)[]>();
		let er = erByStreak.get(streakThreshold);
		if (!er) {
			er = buildEfficiencyRatio(cleanData, streakThreshold);
			erByStreak.set(streakThreshold, er);
		}

		// Compute streaks
		const upperFlags = new Array(cleanData.length).fill(0);
		const lowerFlags = new Array(cleanData.length).fill(0);
		for (let j = 0; j < cleanData.length; j++) {
			if (acceptance[j] > acceptanceThreshold) {
				upperFlags[j] = 1;
			} else if (acceptance[j] < -acceptanceThreshold) {
				lowerFlags[j] = -1;
			}
		}
		const upperStreaks = buildStreakCount(upperFlags);
		const lowerStreaks = buildStreakCount(lowerFlags);

		return createSignalLoop(cleanData, [er], (i) => {
			if (i < streakThreshold) return null;
			const currentEr = er[i];
			if (currentEr === null || currentEr >= 0.35) return null;

			if (lowerStreaks[i] <= -streakThreshold) {
				return createBuySignal(cleanData, i, `Bearish acceptance streak of ${Math.abs(lowerStreaks[i])} bars with weak efficiency ratio (${currentEr.toFixed(2)})`);
			}
			if (upperStreaks[i] >= streakThreshold) {
				return createSellSignal(cleanData, i, `Bullish acceptance streak of ${upperStreaks[i]} bars with weak efficiency ratio (${currentEr.toFixed(2)})`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		acceptance_asymmetry_streak_exhaustion.executePrepared!(
			acceptance_asymmetry_streak_exhaustion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["acceptanceThreshold", "streakThreshold"],
	},
};
