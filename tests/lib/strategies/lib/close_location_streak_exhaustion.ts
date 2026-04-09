import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { extractBarMetricSeries, buildStreakCount } from "./price-action-statistics-core";

function normalizeCloseLocationStreakExhaustionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		streak_len: Math.max(1, Math.round(params.streak_len ?? 4)),
		close_loc_extreme_pct: Math.max(0.01, Math.min(0.49, Number(params.close_loc_extreme_pct ?? 0.15))) };
}

export const close_location_streak_exhaustion: Strategy = {
	name: "Close Location Streak Exhaustion",
	description: "A consecutive streak of closes pinned at the extreme edge of the bar range exhausts directional liquidity, forcing a mean-reverting snapback.",
	defaultParams: {
		streak_len: 4,
		close_loc_extreme_pct: 0.15 },
	paramLabels: {
		streak_len: "Streak Length",
		close_loc_extreme_pct: "Close Location Extreme" },
	normalizeParams: normalizeCloseLocationStreakExhaustionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeCloseLocationStreakExhaustionParams(params);
		const minWarmup = p.streak_len + 1;
		if (cleanData.length < minWarmup) return [];

		const closeLoc = extractBarMetricSeries(cleanData, "closeLocation");
		const lowFlags = new Array(cleanData.length).fill(0);
		const highFlags = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			if (closeLoc[i] < p.close_loc_extreme_pct) lowFlags[i] = -1;
			if (closeLoc[i] > (1 - p.close_loc_extreme_pct)) highFlags[i] = 1;
		}
		const lowStreaks = buildStreakCount(lowFlags);
		const highStreaks = buildStreakCount(highFlags);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < 1) return null;

			if (lowStreaks[i - 1] <= -p.streak_len) {
				return createBuySignal(cleanData, i, `Low close location streak ${Math.abs(lowStreaks[i - 1])} >= ${p.streak_len}, snap back`);
			}
			if (highStreaks[i - 1] >= p.streak_len) {
				return createSellSignal(cleanData, i, `High close location streak ${highStreaks[i - 1]} >= ${p.streak_len}, snap back`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["streak_len", "close_loc_extreme_pct"] } };
