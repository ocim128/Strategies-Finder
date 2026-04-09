import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { extractBarMetricSeries, buildStreakCount } from "./price-action-statistics-core";

function normalizeCloseLocationPhiCompressionStreakParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		streak_len: Math.max(1, Math.round(params.streak_len ?? 5)),
		phi_band_lower: Math.max(0.01, Number(params.phi_band_lower ?? 0.382)),
		phi_band_upper: Math.min(0.99, Number(params.phi_band_upper ?? 0.618)) };
}

export const close_location_phi_compression_streak: Strategy = {
	name: "Close Location Phi Compression Streak",
	description: "When close location is trapped between the golden ratio band (0.382-0.618) for a sustained streak, the auction is violently compressing. A breakout from this streak ignites an impulse.",
	defaultParams: {
		streak_len: 5,
		phi_band_lower: 0.382,
		phi_band_upper: 0.618 },
	paramLabels: {
		streak_len: "Streak Length",
		phi_band_lower: "Phi Band Lower",
		phi_band_upper: "Phi Band Upper" },
	normalizeParams: normalizeCloseLocationPhiCompressionStreakParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeCloseLocationPhiCompressionStreakParams(params);
		const minWarmup = Math.max(p.streak_len, 2);
		if (cleanData.length < minWarmup + 1) return [];

		const closeLocation = extractBarMetricSeries(cleanData, "closeLocation");
		const closes = getCloses(cleanData);
		const { highest, lowest } = buildTrailingHighLow(cleanData, p.streak_len);

		const compressionFlags = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			if (closeLocation[i] > p.phi_band_lower && closeLocation[i] < p.phi_band_upper) {
				compressionFlags[i] = 1;
			}
		}
		const streaks = buildStreakCount(compressionFlags);

		return createSignalLoop(cleanData, [highest, lowest], (i) => {
			if (i < 1) return null;

			const prevStreak = streaks[i - 1];
			if (prevStreak < p.streak_len) return null;

			const prevHi = highest[i - 1];
			const prevLo = lowest[i - 1];
			if (prevHi === null || prevLo === null) return null;

			if (closes[i] > prevHi) {
				return createBuySignal(cleanData, i, `Compression streak ${prevStreak} >= ${p.streak_len}, broke above trailing high`);
			}
			if (closes[i] < prevLo) {
				return createSellSignal(cleanData, i, `Compression streak ${prevStreak} >= ${p.streak_len}, broke below trailing low`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["streak_len", "phi_band_lower", "phi_band_upper"] } };
