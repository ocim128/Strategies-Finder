import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows } from "../strategy-helpers";
import { calculateDonchianChannels } from "../indicators";

function normalizeDonchianMidpointStructuralRetestParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 20)),
		touch_tolerance_pct: Math.max(0.001, Math.abs(Number(params.touch_tolerance_pct ?? 0.2))) };
}

export const donchian_midpoint_structural_retest: Strategy = {
	name: "Donchian Midpoint Structural Retest",
	description: "In a directional expansion, price returning to the Donchian midpoint provides a volatility-adjusted retest entry in the direction of the macro breakout.",
	defaultParams: {
		lookback: 20,
		touch_tolerance_pct: 0.2 },
	paramLabels: {
		lookback: "Donchian Lookback",
		touch_tolerance_pct: "Touch Tolerance %" },
	normalizeParams: normalizeDonchianMidpointStructuralRetestParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeDonchianMidpointStructuralRetestParams(params);
		if (cleanData.length < p.lookback) return [];

		const closes = getCloses(cleanData);
		const highs = getHighs(cleanData);
		const lows = getLows(cleanData);
		const dc = calculateDonchianChannels(highs, lows, p.lookback);

		return createSignalLoop(cleanData, [dc.upper, dc.lower, dc.middle], (i) => {
			const upper = dc.upper[i];
			const lower = dc.lower[i];
			const middle = dc.middle[i];
			if (upper === null || lower === null || middle === null) return null;

			const range = upper - lower;
			if (range <= 0) return null;
			const tolerance = range * p.touch_tolerance_pct;

			const distFromMid = Math.abs(lows[i] - middle);
			if (distFromMid <= tolerance && closes[i] > middle && closes[i] < upper) {
				return createBuySignal(cleanData, i, `Low touched Donchian midpoint within ${(p.touch_tolerance_pct * 100).toFixed(1)}%, bullish retest`);
			}

			const distFromMidHigh = Math.abs(highs[i] - middle);
			if (distFromMidHigh <= tolerance && closes[i] < middle && closes[i] > lower) {
				return createSellSignal(cleanData, i, `High touched Donchian midpoint within ${(p.touch_tolerance_pct * 100).toFixed(1)}%, bearish retest`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "touch_tolerance_pct"] } };
