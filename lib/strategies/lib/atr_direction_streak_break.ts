import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses } from "../strategy-helpers";
import { buildStreakCount } from "./price-action-statistics-core";
import { calculateATR } from "../indicators";

function normalizeAtrDirectionStreakBreakParams(params: StrategyParams): StrategyParams {
	const atrPeriod = Math.max(2, Math.round(params.atrPeriod ?? 14));
	const minStreak = Math.min(10, Math.max(2, Math.round(params.minStreak ?? 3)));
	return { ...params, atrPeriod, minStreak };
}

export const atr_direction_streak_break: Strategy = {
	name: "ATR Direction Streak Break",
	description:
		"ATR measures realized volatility. When ATR expands for many consecutive bars (directional streak), volatility is systematically increasing. The bar where this streak breaks (ATR contracts after N+ bars of expansion) marks the inflection point where volatility regime shifts from expansion to contraction. Entering in the direction of the close at this inflection captures the transition.",
	defaultParams: { atrPeriod: 14, minStreak: 3 },
	paramLabels: { atrPeriod: "ATR Period", minStreak: "Min Streak" },
	normalizeParams: normalizeAtrDirectionStreakBreakParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeAtrDirectionStreakBreakParams(params);
		if (cleanData.length < np.atrPeriod + np.minStreak + 2) return [];
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const closes = getCloses(cleanData);
		const atr = calculateATR(highs, lows, closes, np.atrPeriod);
		const atrDir: number[] = new Array(cleanData.length).fill(0);
		for (let i = 1; i < cleanData.length; i++) {
			const prev = atr[i - 1];
			const curr = atr[i];
			if (prev !== null && curr !== null) {
				atrDir[i] = curr > prev ? 1 : 0;
			}
		}
		const streaks = buildStreakCount(atrDir);
		return createSignalLoop(cleanData, [atr], (i) => {
			if (i < 2) return null;
			const prevStreak = streaks[i - 1];
			const currDir = atrDir[i];
			if (prevStreak < np.minStreak || currDir !== 0) return null;
			if (closes[i] > closes[i - 1])
				return createBuySignal(cleanData, i, `ATR expansion streak ${prevStreak} broke, upward direction`);
			if (closes[i] < closes[i - 1])
				return createSellSignal(cleanData, i, `ATR expansion streak ${prevStreak} broke, downward direction`);
			return null;
		});
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["atrPeriod", "minStreak"] } };
