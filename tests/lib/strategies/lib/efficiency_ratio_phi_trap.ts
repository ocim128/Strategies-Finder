import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { buildEfficiencyRatio } from "./price-action-statistics-core";

function normalizeEfficiencyRatioPhiTrapParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		er_lookback: Math.max(2, Math.round(params.er_lookback ?? 14)),
		er_ceiling: Math.max(0.01, Math.min(1, Number(params.er_ceiling ?? 0.382))),
		extreme_lookback: Math.max(2, Math.round(params.extreme_lookback ?? 20)),
	};
}

export const efficiency_ratio_phi_trap: Strategy = {
	name: "Efficiency Ratio Phi Trap",
	description: "When path efficiency stays trapped below 0.382, the market is purely mean-reverting. Price pushing beyond the trailing extreme signals a false breakout trap.",
	defaultParams: {
		er_lookback: 14,
		er_ceiling: 0.382,
		extreme_lookback: 20,
	},
	paramLabels: {
		er_lookback: "ER Lookback",
		er_ceiling: "ER Ceiling",
		extreme_lookback: "Extreme Lookback",
	},
	normalizeParams: normalizeEfficiencyRatioPhiTrapParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeEfficiencyRatioPhiTrapParams(params);
		const minBars = Math.max(p.er_lookback, p.extreme_lookback);
		if (cleanData.length < minBars) return [];

		const closes = getCloses(cleanData);
		const er = buildEfficiencyRatio(cleanData, p.er_lookback);
		const { highest, lowest } = buildTrailingHighLow(cleanData, p.extreme_lookback);

		return createSignalLoop(cleanData, [er, highest, lowest], (i) => {
			if (i < minBars) return null;
			const erVal = er[i];
			const trailHigh = highest[i];
			const trailLow = lowest[i];
			if (erVal === null || trailHigh === null || trailLow === null) return null;
			if (erVal >= p.er_ceiling) return null;

			if (closes[i] < trailLow) return createBuySignal(cleanData, i, "False breakdown in chop regime");
			if (closes[i] > trailHigh) return createSellSignal(cleanData, i, "False breakout in chop regime");
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["er_lookback", "er_ceiling", "extreme_lookback"],
	},
};
