import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { extractBarMetricSeries, buildStreakCount } from "./price-action-statistics-core";

function normalizeBodyDirectionStreakExhaustionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		streakThreshold: Math.max(2, Math.round(params.streakThreshold ?? 7)) };
}

export const body_direction_streak_exhaustion: Strategy = {
	name: "Body Direction Streak Exhaustion",
	description: "When consecutive same-direction bars persist for an abnormally long streak, directional liquidity is depleted and counter-entry is favored.",
	defaultParams: {
		streakThreshold: 7 },
	paramLabels: {
		streakThreshold: "Streak Threshold" },
	normalizeParams: normalizeBodyDirectionStreakExhaustionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeBodyDirectionStreakExhaustionParams(params);
		const minWarmup = p.streakThreshold + 1;
		if (cleanData.length < minWarmup) return [];

		const bodyDir = extractBarMetricSeries(cleanData, "bodyDirection");
		const downFlags = new Array(cleanData.length).fill(0);
		const upFlags = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			if (bodyDir[i] < 0) downFlags[i] = -1;
			if (bodyDir[i] > 0) upFlags[i] = 1;
		}
		const downStreaks = buildStreakCount(downFlags);
		const upStreaks = buildStreakCount(upFlags);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < 1) return null;

			if (downStreaks[i - 1] <= -p.streakThreshold) {
				return createBuySignal(cleanData, i, `Bearish streak ${Math.abs(downStreaks[i - 1])} >= ${p.streakThreshold}, selling exhausted`);
			}
			if (upStreaks[i - 1] >= p.streakThreshold) {
				return createSellSignal(cleanData, i, `Bullish streak ${upStreaks[i - 1]} >= ${p.streakThreshold}, buying exhausted`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["streakThreshold"] } };
