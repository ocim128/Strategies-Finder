import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildRollingAverage, clamp } from "./price-action-frequency-core";

export const previous_midpoint_reclaim_score: Strategy = {
	name: "Previous Midpoint Reclaim Score",
	description: "Scores repeated reclaims of the previous candle midpoint after intrabar probing through that level.",
	defaultParams: {
		lookback: 5,
		reclaimThreshold: 0.2,
		minReclaimPct: 0.12,
	},
	paramLabels: {
		lookback: "Score Window (bars)",
		reclaimThreshold: "Persistence Threshold",
		minReclaimPct: "Min Reclaim Distance",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		if (cleanData.length < 3) return [];

		const lookback = Math.max(2, Math.round(params.lookback ?? 5));
		const reclaimThreshold = clamp(params.reclaimThreshold ?? 0.2, 0, 1);
		const minReclaimPct = clamp(params.minReclaimPct ?? 0.12, 0, 1);

		const barScore: number[] = new Array(cleanData.length).fill(0);
		for (let i = 1; i < cleanData.length; i++) {
			const prev = cleanData[i - 1];
			const curr = cleanData[i];
			const prevRange = prev.high - prev.low;
			if (prevRange <= 0) continue;

			const prevMid = (prev.high + prev.low) / 2;
			const bullishReclaim = curr.low < prevMid && curr.close > prevMid && curr.close >= curr.open;
			const bearishReclaim = curr.high > prevMid && curr.close < prevMid && curr.close <= curr.open;
			const reclaimDistance = Math.abs(curr.close - prevMid) / prevRange;
			if (reclaimDistance < minReclaimPct) continue;

			if (bullishReclaim) {
				barScore[i] = clamp((curr.close - prevMid) / prevRange, 0, 1);
			} else if (bearishReclaim) {
				barScore[i] = -clamp((prevMid - curr.close) / prevRange, 0, 1);
			}
		}

		const avgScore = buildRollingAverage(barScore, lookback);

		return createSignalLoop(cleanData, [avgScore], (i) => {
			const score = avgScore[i] as number;
			if (score > reclaimThreshold) {
				return createBuySignal(cleanData, i, "Previous midpoint reclaim bullish");
			}
			if (score < -reclaimThreshold) {
				return createSellSignal(cleanData, i, "Previous midpoint reclaim bearish");
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "reclaimThreshold", "minReclaimPct"],
	},
};
