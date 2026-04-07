import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { extractBarMetricSeries, buildStreakCount } from "./price-action-statistics-core";

function normalizeGapPctStreakContinuationParams(params: StrategyParams): StrategyParams {
	const minStreak = Math.min(8, Math.max(2, Math.round(params.minStreak ?? 3)));
	const minGapPct = Math.min(2.0, Math.max(0.05, Number(params.minGapPct ?? 0.2)));
	return { ...params, minStreak, minGapPct };
}

export const gap_pct_streak_continuation: Strategy = {
	name: "Gap Pct Streak Continuation",
	description:
		"When gaps (open vs prior close) persist in the same direction for consecutive bars, informed participants are consistently pushing the market in one direction during illiquid hours. Rather than fading these gaps (reversion), the continuation hypothesis holds that persistent same-direction gaps indicate strong institutional flow that will continue. Enter in the gap direction after N consecutive same-direction gaps.",
	defaultParams: { minStreak: 3, minGapPct: 0.2 },
	paramLabels: { minStreak: "Min Streak", minGapPct: "Min Gap Pct (%)" },
	normalizeParams: normalizeGapPctStreakContinuationParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeGapPctStreakContinuationParams(params);
		if (cleanData.length < np.minStreak + 2) return [];
		const gapPct = extractBarMetricSeries(cleanData, "gapPct");
		const gapDir: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			if (gapPct[i] > np.minGapPct) gapDir[i] = 1;
			else if (gapPct[i] < -np.minGapPct) gapDir[i] = -1;
		}
		const streaks = buildStreakCount(gapDir);
		return createSignalLoop(cleanData, [streaks.map((s) => s as number | null)], (i) => {
			const streak = streaks[i];
			const dir = gapDir[i];
			if (streak >= np.minStreak && dir === 1)
				return createBuySignal(cleanData, i, `Positive gap streak ${streak}, continuation`);
			if (streak <= -np.minStreak && dir === -1)
				return createSellSignal(cleanData, i, `Negative gap streak ${Math.abs(streak)}, continuation`);
			return null;
		});
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["minStreak", "minGapPct"] } };
