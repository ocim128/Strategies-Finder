import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses } from "../strategy-helpers";
import { calculateKeltnerChannels } from "../indicators";

function normalizeKeltnerMidpointAlignmentParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 55))) };
}

export const keltner_midpoint_alignment: Strategy = {
	name: "Keltner Midpoint Alignment",
	description: "Aligns daily close relative to the Keltner channel midline as the volatility-adjusted value reference, producing symmetric long/short signals on acceptance above or below the anchor.",
	defaultParams: {
		lookback: 55 },
	paramLabels: {
		lookback: "Lookback" },
	normalizeParams: normalizeKeltnerMidpointAlignmentParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeKeltnerMidpointAlignmentParams(params);
		const lookback = p.lookback as number;
		if (cleanData.length < lookback + 1) return [];

		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const closes = getCloses(cleanData);
		const channels = calculateKeltnerChannels(highs, lows, closes, lookback, lookback, 1.5);

		return createSignalLoop(cleanData, [channels.middle], (i) => {
			const mid = channels.middle[i];
			if (mid === null) return null;

			if (closes[i] > mid) {
				return createBuySignal(cleanData, i, `Close ${closes[i].toFixed(2)} above Keltner midpoint ${mid.toFixed(2)}`);
			}
			if (closes[i] < mid) {
				return createSellSignal(cleanData, i, `Close ${closes[i].toFixed(2)} below Keltner midpoint ${mid.toFixed(2)}`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"] } };
