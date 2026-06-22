import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingMinMax } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
		efficiencyThreshold: Math.max(0.01, Math.min(1.0, Number(params.efficiencyThreshold ?? 0.15))),
	};
}

export const efficiency_gated_boundary_fade: Strategy = {
	name: "Efficiency-Gated Boundary Fade",
	description: "Fades the ratio when it reaches its rolling min/max boundary but the efficiency ratio is extremely low.",
	defaultParams: {
		lookback: 30,
		efficiencyThreshold: 0.15,
	},
	paramLabels: {
		lookback: "Lookback Window",
		efficiencyThreshold: "Efficiency Threshold",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const efficiencyThreshold = p.efficiencyThreshold as number;
		if (cleanData.length < lookback + 1) return [];

		const closes = getCloses(cleanData);
		const efficiency = buildEfficiencyRatio(cleanData, lookback);
		const minMax = buildRollingMinMax(closes, lookback, true);

		return createSignalLoop(cleanData, [efficiency], (i) => {
			if (i < lookback) return null;
			const eff = efficiency[i];
			if (eff === null || eff >= efficiencyThreshold) return null;

			const minVal = minMax.min[i];
			const maxVal = minMax.max[i];
			if (minVal === null || maxVal === null) return null;

			const closeVal = closes[i];
			if (closeVal <= minVal) {
				return createBuySignal(cleanData, i, `Price touched rolling min ${minVal.toFixed(4)} with low efficiency (${eff.toFixed(2)} < ${efficiencyThreshold})`);
			}
			if (closeVal >= maxVal) {
				return createSellSignal(cleanData, i, `Price touched rolling max ${maxVal.toFixed(4)} with low efficiency (${eff.toFixed(2)} < ${efficiencyThreshold})`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "efficiencyThreshold"],
	},
};
