import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, ensureCleanData, getHighs, getLows, getCloses } from "../strategy-helpers";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeInsideBarNestingBreakoutParams(params: StrategyParams): StrategyParams {
	const minNest = Math.max(1, Math.round(params.minNest ?? 2));
	return { ...params, minNest };
}

export const inside_bar_nesting_breakout: Strategy = {
	name: "Inside Bar Nesting Breakout",
	description:
		"An inside bar (high <= prior high AND low >= prior low) is a range contraction where the current bar is entirely contained within the prior bar's range. Consecutive inside bars create a nesting pattern. The deeper the nesting, the more energy is stored. Breakout direction from a deep nest carries disproportionate momentum.",
	defaultParams: { minNest: 2 },
	paramLabels: { minNest: "Min Nest Depth" },
	normalizeParams: normalizeInsideBarNestingBreakoutParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeInsideBarNestingBreakoutParams(params);
		if (cleanData.length < np.minNest + 2) return [];
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const closes = getCloses(cleanData);
		const insideFlags: number[] = new Array(cleanData.length).fill(0);
		for (let i = 1; i < cleanData.length; i++) {
			if (highs[i] <= highs[i - 1] && lows[i] >= lows[i - 1]) insideFlags[i] = 1;
		}
		const streaks = buildStreakCount(insideFlags);
		const signals: ReturnType<typeof createBuySignal>[] = [];
		for (let i = 1; i < cleanData.length; i++) {
			if (insideFlags[i] === 1) continue;
			if (streaks[i - 1] < np.minNest) continue;
			if (closes[i] > highs[i - 1])
				signals.push(createBuySignal(cleanData, i, `Inside bar nest depth ${streaks[i - 1]} breakout upward`));
			else if (closes[i] < lows[i - 1])
				signals.push(createSellSignal(cleanData, i, `Inside bar nest depth ${streaks[i - 1]} breakout downward`));
		}
		return signals;
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["minNest"] } };
