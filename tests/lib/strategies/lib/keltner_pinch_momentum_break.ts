import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { calculateKeltnerChannels } from "../indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		keltnerPeriod: Math.max(5, Math.round(params.keltnerPeriod ?? 20)),
		keltnerMultiplier: Math.max(0.1, Number(params.keltnerMultiplier ?? 1.5)),
		channelWidthMaxRatio: Math.max(0, Number(params.channelWidthMaxRatio ?? 0.005)) };
}

export const keltner_pinch_momentum_break: Strategy = {
	name: "Keltner Pinch Momentum Break",
	description: "Keltner Channels pinch tight due to falling ATR, signaling a volatility contraction, followed by a clean structural breakout.",
	defaultParams: {
		keltnerPeriod: 20,
		keltnerMultiplier: 1.5,
		channelWidthMaxRatio: 0.005 },
	paramLabels: {
		keltnerPeriod: "Keltner Period",
		keltnerMultiplier: "Channel Multiplier",
		channelWidthMaxRatio: "Max Width Ratio" },
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		if (cleanData.length < p.keltnerPeriod + 5) return [];

		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const closes = getCloses(cleanData);

		const kc = calculateKeltnerChannels(highs, lows, closes, p.keltnerPeriod, p.keltnerPeriod, p.keltnerMultiplier);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < p.keltnerPeriod) return null;

			const prevUpper = kc.upper[i - 1];
			const prevLower = kc.lower[i - 1];
			const prevMid = kc.middle[i - 1];

			if (prevUpper === null || prevLower === null || prevMid === null) return null;

			// Check channel width ratio up to previous bar
			const widthPct = (prevUpper - prevLower) / prevMid;

			if (widthPct > p.channelWidthMaxRatio) return null;

			const bar = cleanData[i];

			// Breakout up
			if (bar.close > prevUpper) {
				return createBuySignal(cleanData, i, `KC Breakout High (${(widthPct * 100).toFixed(2)}%)`);
			}

			// Breakout down
			if (bar.close < prevLower) {
				return createSellSignal(cleanData, i, `KC Breakout Low (${(widthPct * 100).toFixed(2)}%)`);
			}

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["keltnerPeriod", "keltnerMultiplier", "channelWidthMaxRatio"] } };
