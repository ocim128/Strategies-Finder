import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateSupertrend } from "../indicators";
import { buildRollingZScore } from "./price-action-statistics-core";

export const supertrend_distance_zscore: Strategy = {
	name: "Supertrend Distance Z-Score",
	description: "Quantifies the elastic stretch between price and the Supertrend step line. Uses a rolling z-score of that distance to pinpoint exact moments when the market has statistically exhausted its directional momentum and must revert to the median trend.",
	defaultParams: {
		stPeriod: 10,
		zscoreLookback: 50,
		zscoreTrigger: 2.5,
	},
	paramLabels: {
		stPeriod: "Supertrend ATR Baseline",
		zscoreLookback: "Distance Distribution Window",
		zscoreTrigger: "Elastic Snap Threshold",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const stPeriod = params.stPeriod as number;
		const zLookback = params.zscoreLookback as number;

		if (cleanData.length < Math.max(stPeriod * 2, zLookback)) return [];

		const st = calculateSupertrend(
			cleanData.map(d => d.high),
			cleanData.map(d => d.low),
			cleanData.map(d => d.close),
			stPeriod,
			3.0
		);

		// Signed distance: positive when Close > ST line, negative when Close < ST line
		const distances = cleanData.map((d, i) => {
			if (st.supertrend[i] === null || st.direction[i] === null) return 0;
			return d.close - st.supertrend[i]!;
		});

		const zscore = buildRollingZScore(distances, zLookback);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < Math.max(stPeriod * 2, zLookback) || zscore[i] === null || st.direction[i] === null) return null;

			const z = zscore[i]!;
			const trigger = params.zscoreTrigger as number;
			const isBullishST = st.direction[i] === 1;
			const isBearishST = st.direction[i] === -1;

			// Fade extreme upside extension within a bullish Supertrend
			if (isBullishST && z > trigger) {
				return createSellSignal(cleanData, i, "Extreme upside overextension from Supertrend elastic band fade");
			}
			// Fade extreme downside extension within a bearish Supertrend
			if (isBearishST && z < -trigger) {
				return createBuySignal(cleanData, i, "Extreme downside overextension from Supertrend elastic band fade");
			}

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["stPeriod", "zscoreLookback", "zscoreTrigger"],
	},
};
