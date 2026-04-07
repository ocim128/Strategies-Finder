import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingMedian, buildStreakCount } from "./price-action-statistics-core";

function normalizeMedianDeviationStreakParams(params: StrategyParams): StrategyParams {
	const medianLookback = Math.max(2, Math.round(params.medianLookback ?? 20));
	const rawStreakThreshold = Number(params.streakThreshold ?? 5);
	const streakThreshold = Math.max(1, Math.abs(Math.round(Number.isFinite(rawStreakThreshold) ? rawStreakThreshold : 5)));

	return {
		...params,
		medianLookback,
		streakThreshold };
}

export const median_deviation_streak: Strategy = {
	name: "Median Deviation Streak",
	description: "Tracks consecutive bars where the close remains above or below its rolling median, and enters when the streak reaches a persistence threshold.",
	defaultParams: {
		medianLookback: 20,
		streakThreshold: 5 },
	paramLabels: {
		medianLookback: "Median Lookback",
		streakThreshold: "Streak Threshold" },
	normalizeParams: normalizeMedianDeviationStreakParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeMedianDeviationStreakParams(params);
		if (cleanData.length < normalizedParams.medianLookback + normalizedParams.streakThreshold) return [];

		const closes = getCloses(cleanData);
		const medias = buildRollingMedian(closes, normalizedParams.medianLookback);

		const signs = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			const med = medias[i];
			if (med === null) continue;
			if (closes[i] > med) signs[i] = 1;
			else if (closes[i] < med) signs[i] = -1;
		}

		const streaks = buildStreakCount(signs);

		return createSignalLoop(cleanData, [streaks], (i) => {
			const streak = streaks[i];

			if (streak >= normalizedParams.streakThreshold) {
				return createBuySignal(cleanData, i, `Median Streak >= ${normalizedParams.streakThreshold}`);
			}
			if (streak <= -normalizedParams.streakThreshold) {
				return createSellSignal(cleanData, i, `Median Streak <= -${normalizedParams.streakThreshold}`);
			}

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["medianLookback", "streakThreshold"] } };
