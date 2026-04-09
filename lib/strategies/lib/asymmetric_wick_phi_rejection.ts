import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeAsymmetricWickPhiRejectionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 14)),
		phi_imbalance_limit: Math.max(0.01, Math.min(1, Number(params.phi_imbalance_limit ?? 0.382))),
	};
}

export const asymmetric_wick_phi_rejection: Strategy = {
	name: "Asymmetric Wick Phi Rejection",
	description: "Rolling average of wick imbalance exceeding a 0.382 structural volatility threshold confirms a persistent passive iceberg absorbing all initiative flow.",
	defaultParams: {
		lookback: 14,
		phi_imbalance_limit: 0.382,
	},
	paramLabels: {
		lookback: "Lookback",
		phi_imbalance_limit: "Phi Imbalance Limit",
	},
	normalizeParams: normalizeAsymmetricWickPhiRejectionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeAsymmetricWickPhiRejectionParams(params);
		if (cleanData.length < p.lookback) return [];

		const wickImbalance = extractBarMetricSeries(cleanData, "wickImbalance");
		const smoothed = buildRollingAverage(wickImbalance, p.lookback);

		return createSignalLoop(cleanData, [smoothed], (i) => {
			const val = smoothed[i];
			if (val === null) return null;
			if (val > p.phi_imbalance_limit) return createBuySignal(cleanData, i, "Persistent lower wick rejection");
			if (val < -p.phi_imbalance_limit) return createSellSignal(cleanData, i, "Persistent upper wick rejection");
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "phi_imbalance_limit"],
	},
};
