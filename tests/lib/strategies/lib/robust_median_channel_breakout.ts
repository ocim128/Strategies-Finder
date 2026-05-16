import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeRobustMedianChannelBreakoutParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 40)),
	};
}

export const robust_median_channel_breakout: Strategy = {
	name: "Robust Median Channel Breakout",
	description: "Constructs a highly resilient trailing channel using the rolling median of highs and the rolling median of lows, entering on structural containment breaks.",
	defaultParams: {
		lookback: 40,
	},
	paramLabels: {
		lookback: "Lookback",
	},
	normalizeParams: normalizeRobustMedianChannelBreakoutParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeRobustMedianChannelBreakoutParams(params);
		const lookback = p.lookback as number;
		if (cleanData.length < lookback + 2) return [];

		const closes = getCloses(cleanData);
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const medianHighs = buildRollingMedian(highs, lookback);
		const medianLows = buildRollingMedian(lows, lookback);

		return createSignalLoop(cleanData, [medianHighs, medianLows], (i) => {
			const mHi = medianHighs[i];
			const mLo = medianLows[i];
			if (mHi === null || mLo === null) return null;

			if (closes[i] > mHi) {
				return createBuySignal(cleanData, i, "Close broke above median-of-highs channel");
			}
			if (closes[i] < mLo) {
				return createSellSignal(cleanData, i, "Close broke below median-of-lows channel");
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"],
	},
};
