import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getHighs, getLows, getCloses } from "../strategy-helpers";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeRangeAsymmetryStreakFadeParams(params: StrategyParams): StrategyParams {
	const minStreak = Math.min(8, Math.max(3, Math.round(params.minStreak ?? 4)));
	return { ...params, minStreak };
}

export const range_asymmetry_streak_fade: Strategy = {
	name: "Range Asymmetry Streak Fade",
	description:
		"For each bar, measure whether (high - close) exceeds (close - low) — this is the range asymmetry direction. When one side dominates for N consecutive bars, the market is structurally rejecting that direction. The streak-break fade captures the exhaustion of this one-sided rejection pattern.",
	defaultParams: { minStreak: 4 },
	paramLabels: { minStreak: "Min Asymmetry Streak" },
	normalizeParams: normalizeRangeAsymmetryStreakFadeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeRangeAsymmetryStreakFadeParams(params);
		if (cleanData.length < np.minStreak + 2) return [];
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const closes = getCloses(cleanData);
		const upperDomFlags: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			const upperDist = highs[i] - closes[i];
			const lowerDist = closes[i] - lows[i];
			if (upperDist > lowerDist) upperDomFlags[i] = 1;
		}
		const lowerDomFlags: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			const upperDist = highs[i] - closes[i];
			const lowerDist = closes[i] - lows[i];
			if (lowerDist > upperDist) lowerDomFlags[i] = 1;
		}
		const upperStreaks = buildStreakCount(upperDomFlags);
		const lowerStreaks = buildStreakCount(lowerDomFlags);
		const signals: ReturnType<typeof createBuySignal>[] = [];
		for (let i = 1; i < cleanData.length; i++) {
			if (upperStreaks[i - 1] >= np.minStreak && lowerDomFlags[i] === 1)
				signals.push(createBuySignal(cleanData, i, `Fade after ${upperStreaks[i - 1]}-bar upper-dominance streak`));
			if (lowerStreaks[i - 1] >= np.minStreak && upperDomFlags[i] === 1)
				signals.push(createSellSignal(cleanData, i, `Fade after ${lowerStreaks[i - 1]}-bar lower-dominance streak`));
		}
		return signals;
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["minStreak"] } };
