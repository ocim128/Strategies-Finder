import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, checkCrossover, getCloses } from "../strategy-helpers";
import { buildRollingSkewness } from "./price-action-statistics-core";

function normalizeSkewnessPhiPolarizationReversalParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 30)),
		skew_phi_bound: Math.max(0.01, Number(params.skew_phi_bound ?? 0.382)),
	};
}

export const skewness_phi_polarization_reversal: Strategy = {
	name: "Skewness Phi Polarization Reversal",
	description: "Extreme return skewness crossing back across a 0.382 boundary flags the exact moment tail-risk polarization dies and mean-reversion takes over.",
	defaultParams: {
		lookback: 30,
		skew_phi_bound: 0.382,
	},
	paramLabels: {
		lookback: "Lookback",
		skew_phi_bound: "Skew Phi Bound",
	},
	normalizeParams: normalizeSkewnessPhiPolarizationReversalParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeSkewnessPhiPolarizationReversalParams(params);
		if (cleanData.length < p.lookback) return [];

		const closes = getCloses(cleanData);
		const returns = new Array(closes.length).fill(0);
		for (let j = 1; j < closes.length; j++) {
			returns[j] = closes[j - 1] !== 0 ? (closes[j] - closes[j - 1]) / closes[j - 1] : 0;
		}

		const skewness = buildRollingSkewness(returns, p.lookback);
		const negBound = new Array(cleanData.length).fill(-p.skew_phi_bound);
		const posBound = new Array(cleanData.length).fill(p.skew_phi_bound);

		return createSignalLoop(cleanData, [skewness], (i) => {
			if (i < p.lookback) return null;
			const cross = checkCrossover(skewness, negBound, i);
			if (cross === "bullish") return createBuySignal(cleanData, i, "Skewness crosses above negative bound");
			const crossSell = checkCrossover(posBound, skewness, i);
			if (crossSell === "bullish") return createSellSignal(cleanData, i, "Skewness crosses below positive bound");
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "skew_phi_bound"],
	},
};
