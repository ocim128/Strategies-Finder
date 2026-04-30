import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows } from "../strategy-helpers";
import { calculateDonchianChannels } from "../indicators";

function normalizeDonchianMidpointAlignmentParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 55))) };
}

export const donchian_midpoint_alignment: Strategy = {
	name: "Donchian Midpoint Alignment",
	description: "Uses the midpoint of the trailing Donchian channel as the daily value anchor and aligns positions when the close accepts above or below this reference.",
	defaultParams: {
		lookback: 55 },
	paramLabels: {
		lookback: "Lookback" },
	normalizeParams: normalizeDonchianMidpointAlignmentParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeDonchianMidpointAlignmentParams(params);
		const lookback = p.lookback as number;
		if (cleanData.length < lookback + 1) return [];

		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const channels = calculateDonchianChannels(highs, lows, lookback);

		return createSignalLoop(cleanData, [channels.middle], (i) => {
			const mid = channels.middle[i];
			if (mid === null) return null;

			if (cleanData[i].close > mid) {
				return createBuySignal(cleanData, i, `Close ${cleanData[i].close.toFixed(2)} above Donchian midpoint ${mid.toFixed(2)}`);
			}
			if (cleanData[i].close < mid) {
				return createSellSignal(cleanData, i, `Close ${cleanData[i].close.toFixed(2)} below Donchian midpoint ${mid.toFixed(2)}`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"] } };
