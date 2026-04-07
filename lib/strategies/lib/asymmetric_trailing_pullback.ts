import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		trailWindow: Math.max(2, Math.round(params.trailWindow ?? 21)) };
}

export const asymmetric_trailing_pullback: Strategy = {
	name: "Asymmetric Trailing Pullback",
	description: "In a local window, price dropping 61.8% from the high is a value buy, but bouncing just 38.2% from the low is a short entry.",
	defaultParams: {
		trailWindow: 21 },
	paramLabels: {
		trailWindow: "Trail Window" },
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeParams(params);
		if (cleanData.length < normalizedParams.trailWindow) return [];

		const { highest, lowest } = buildTrailingHighLow(cleanData, normalizedParams.trailWindow, false);
		const closes = getCloses(cleanData);

		return createSignalLoop(cleanData, [highest, lowest, closes], (i) => {
			const hi = highest[i]!;
			const lo = lowest[i]!;
			const c = closes[i]!;

			const span = hi - lo;
			if (span <= 0) return null;

			if ((hi - c) > 0.618 * span) {
				return createBuySignal(cleanData, i, "Close dropped > 0.618 from trailing high");
			}

			if ((c - lo) > 0.382 * span) {
				return createSellSignal(cleanData, i, "Close rose > 0.382 from trailing low");
			}

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["trailWindow"] } };
