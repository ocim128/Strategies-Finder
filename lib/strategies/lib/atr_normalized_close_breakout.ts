import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { calculateATR } from "../indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
		atrMultiplier: Math.max(0.1, Number(params.atrMultiplier ?? 2.0)),
	};
}

export const atr_normalized_close_breakout: Strategy = {
	name: "ATR Normalized Close Breakout",
	description: "Follows price breakouts when the hourly close return exceeds a multiple of the rolling average true range (ATR), identifying high-energy breakouts.",
	defaultParams: {
		lookback: 30,
		atrMultiplier: 2.0,
	},
	paramLabels: {
		lookback: "Lookback Window",
		atrMultiplier: "ATR Multiplier",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const atrMultiplier = p.atrMultiplier as number;
		if (cleanData.length < lookback + 1) return [];

		const closes = getCloses(cleanData);
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);

		const atr = calculateATR(highs, lows, closes, lookback);

		return createSignalLoop(cleanData, [atr], (i) => {
			if (i < lookback) return null;
			const atrVal = atr[i];
			if (atrVal === null || atrVal <= 0) return null;

			const priceChange = closes[i] - closes[i - 1];
			const threshold = atrMultiplier * atrVal;

			if (priceChange > threshold) {
				return createBuySignal(cleanData, i, `Price change (${priceChange.toFixed(4)}) > ATR breakout threshold (${threshold.toFixed(4)})`);
			}
			if (priceChange < -threshold) {
				return createSellSignal(cleanData, i, `Price change (${priceChange.toFixed(4)}) < ATR breakdown threshold (-${threshold.toFixed(4)})`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "atrMultiplier"],
	},
};
