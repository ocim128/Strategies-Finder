import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { calculateSupertrend } from "../indicators";
import { buildRollingZScore } from "./price-action-statistics-core";

export const supertrend_extreme_overextension_fade: Strategy = {
	name: "Supertrend Extreme Overextension Fade",
	description: "Fade price when it deviates too far from the Supertrend line, measured by z-score.",
	defaultParams: {
        stPeriod: 10,
        stFactor: 3.0,
		zLookback: 50,
		zThresh: 2.5,
	},
	paramLabels: {
        stPeriod: "Supertrend Period",
        stFactor: "Supertrend Factor",
		zLookback: "Distance Z-Score Lookback",
		zThresh: "Z-Score Threshold",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const closes = getCloses(cleanData);
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		
        const stPeriod = Number(params.stPeriod ?? 10);
        const stFactor = Number(params.stFactor ?? 3.0);
		const zLookback = Number(params.zLookback ?? 50);
		const zThresh = Number(params.zThresh ?? 2.5);

		if (cleanData.length < Math.max(stPeriod * 2, zLookback)) return [];

		const { supertrend, direction } = calculateSupertrend(highs, lows, closes, stPeriod, stFactor);
		
		const distances = closes.map((close, i) => {
			if (supertrend[i] === null) return 0;
			return (close - supertrend[i]!) / close;
		});

		const zscore = buildRollingZScore(distances, zLookback);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < Math.max(stPeriod * 2, zLookback) || zscore[i] === null || direction[i] === null) return null;

			const dir = direction[i];
			const z = zscore[i]!;

			if (dir === -1 && z <= -zThresh) {
				return createBuySignal(cleanData, i, "Fade extremely far below bearish ST");
			} else if (dir === 1 && z >= zThresh) {
				return createSellSignal(cleanData, i, "Fade extremely far above bullish ST");
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["stPeriod", "stFactor", "zLookback", "zThresh"],
	},
};
