import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getOpens } from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";

function normalizeBodyMidpointMedianCrossParams(params: StrategyParams): StrategyParams {
	const lookback = Math.max(5, Math.round(params.lookback ?? 20));
	return { ...params, lookback };
}

export const body_midpoint_median_cross: Strategy = {
	name: "Body Midpoint Median Cross",
	description:
		"The body midpoint (open + close) / 2 is the settled price of each bar — it ignores wick noise entirely. When this body midpoint crosses its rolling median, the directional settlement level has shifted relative to the robust central tendency. This is the cleanest possible pure price-action regime signal.",
	defaultParams: { lookback: 20 },
	paramLabels: { lookback: "Lookback" },
	normalizeParams: normalizeBodyMidpointMedianCrossParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeBodyMidpointMedianCrossParams(params);
		if (cleanData.length < np.lookback + 2) return [];
		const closes = getCloses(cleanData);
		const opens = getOpens(cleanData);
		const bodyMidpoints = closes.map((c, i) => (opens[i] + c) / 2);
		const median = buildRollingMedian(bodyMidpoints, np.lookback);
		return createSignalLoop(cleanData, [median], (i) => {
			const prevBmp = bodyMidpoints[i - 1];
			const currBmp = bodyMidpoints[i];
			const prevMed = median[i - 1];
			const currMed = median[i];
			if (prevMed === null || currMed === null) return null;
			if (prevBmp < prevMed && currBmp >= currMed)
				return createBuySignal(cleanData, i, `Body midpoint crossed above median`);
			if (prevBmp >= prevMed && currBmp < currMed)
				return createSellSignal(cleanData, i, `Body midpoint crossed below median`);
			return null;
		});
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["lookback"] } };
