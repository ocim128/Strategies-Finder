import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import {
	buildRollingAverage,
	buildTrailingHighLow,
	clamp,
	getPriceActionBarMetrics,
} from "./price-action-frequency-core";

export const micro_sweep_reclaim_score: Strategy = {
	name: "Micro Sweep Reclaim Score",
	description: "Scores fast reclaims after short-window liquidity sweeps through recent highs or lows.",
	defaultParams: {
		sweepLookback: 4,
		reclaimThreshold: 0.58,
		scoreWindow: 5,
	},
	paramLabels: {
		sweepLookback: "Sweep Lookback",
		reclaimThreshold: "Min Close-in-Range Reclaim",
		scoreWindow: "Score Window (bars)",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		if (cleanData.length < 4) return [];

		const sweepLookback = Math.max(2, Math.round(params.sweepLookback ?? 4));
		const reclaimThreshold = clamp(params.reclaimThreshold ?? 0.58, 0, 1);
		const scoreWindow = Math.max(2, Math.round(params.scoreWindow ?? 5));
		const { highest, lowest } = buildTrailingHighLow(cleanData, sweepLookback, false);

		const barScore: number[] = new Array(cleanData.length).fill(0);
		for (let i = 1; i < cleanData.length; i++) {
			const curr = cleanData[i];
			const prev = cleanData[i - 1];
			const recentHigh = highest[i];
			const recentLow = lowest[i];
			if (recentHigh === null || recentLow === null) continue;

			const metrics = getPriceActionBarMetrics(curr);
			if (metrics.range <= 0) continue;

			const bullishSweep =
				curr.low < recentLow &&
				curr.close > prev.close &&
				curr.close > metrics.midpoint &&
				metrics.closeLocation >= reclaimThreshold;
			if (bullishSweep) {
				barScore[i] = 1;
				continue;
			}

			const bearishSweep =
				curr.high > recentHigh &&
				curr.close < prev.close &&
				curr.close < metrics.midpoint &&
				(1 - metrics.closeLocation) >= reclaimThreshold;
			if (bearishSweep) {
				barScore[i] = -1;
			}
		}

		const avgScore = buildRollingAverage(barScore, scoreWindow);
		const signalThreshold = 0.35;

		return createSignalLoop(cleanData, [avgScore], (i) => {
			const score = avgScore[i] as number;
			if (score > signalThreshold) {
				return createBuySignal(cleanData, i, "Micro sweep reclaim bullish");
			}
			if (score < -signalThreshold) {
				return createSellSignal(cleanData, i, "Micro sweep reclaim bearish");
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["sweepLookback", "reclaimThreshold", "scoreWindow"],
	},
};
