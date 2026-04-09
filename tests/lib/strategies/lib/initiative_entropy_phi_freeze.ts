import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildInitiativePressureSeries, buildTrailingHighLow } from "./price-action-frequency-core";
import { buildRollingEntropy } from "./price-action-statistics-core";

function normalizeInitiativeEntropyPhiFreezeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 20)),
		phi_freeze: Math.max(0.01, Number(params.phi_freeze ?? 0.382)),
		pressure_freeze: Math.max(0, Number(params.pressure_freeze ?? 0.5)),
	};
}

export const initiative_entropy_phi_freeze: Strategy = {
	name: "Initiative Entropy Phi Freeze",
	description: "When rolling entropy drops below 0.382 and initiative pressure collapses, the limit orderbook is frozen. Enter on the next directional breakout.",
	defaultParams: {
		lookback: 20,
		phi_freeze: 0.382,
		pressure_freeze: 0.5,
	},
	paramLabels: {
		lookback: "Lookback",
		phi_freeze: "Phi Freeze",
		pressure_freeze: "Pressure Freeze",
	},
	normalizeParams: normalizeInitiativeEntropyPhiFreezeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeInitiativeEntropyPhiFreezeParams(params);
		if (cleanData.length < p.lookback) return [];

		const closes = getCloses(cleanData);
		const entropy = buildRollingEntropy(closes, p.lookback);
		const pressure = buildInitiativePressureSeries(cleanData, p.lookback);
		const { highest, lowest } = buildTrailingHighLow(cleanData, p.lookback);

		return createSignalLoop(cleanData, [entropy, pressure, highest, lowest], (i) => {
			if (i < p.lookback) return null;
			const ent = entropy[i];
			const ip = pressure[i];
			const prevHigh = highest[i - 1];
			const prevLow = lowest[i - 1];
			if (ent === null || ip === null || prevHigh === null || prevLow === null) return null;

			const frozen = ent < p.phi_freeze && Math.abs(ip) < p.pressure_freeze;
			if (!frozen) return null;
			if (closes[i] > prevHigh) return createBuySignal(cleanData, i, "Freeze breakout bullish");
			if (closes[i] < prevLow) return createSellSignal(cleanData, i, "Freeze breakout bearish");
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "phi_freeze", "pressure_freeze"],
	},
};
