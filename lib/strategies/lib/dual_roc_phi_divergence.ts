import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange } from "./price-action-statistics-core";

function normalizeDualRocPhiDivergenceParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		fast_lookback: Math.max(1, Math.round(params.fast_lookback ?? 5)),
		slow_lookback: Math.max(2, Math.round(params.slow_lookback ?? 40)),
		phi_ratio: Math.max(0.01, Number(params.phi_ratio ?? 0.382)),
	};
}

export const dual_roc_phi_divergence: Strategy = {
	name: "Dual ROC Phi Divergence",
	description: "A structural pullback is optimal when fast counter-trend ROC diverges from the dominant slow trend by exactly a 0.382 proportion, signaling proportional exhaustion.",
	defaultParams: {
		fast_lookback: 5,
		slow_lookback: 40,
		phi_ratio: 0.382,
	},
	paramLabels: {
		fast_lookback: "Fast Lookback",
		slow_lookback: "Slow Lookback",
		phi_ratio: "Phi Ratio",
	},
	normalizeParams: normalizeDualRocPhiDivergenceParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeDualRocPhiDivergenceParams(params);
		if (cleanData.length < p.slow_lookback) return [];

		const closes = getCloses(cleanData);
		const fastRoc = buildRateOfChange(closes, p.fast_lookback);
		const slowRoc = buildRateOfChange(closes, p.slow_lookback);

		return createSignalLoop(cleanData, [fastRoc, slowRoc], (i) => {
			if (i < p.slow_lookback) return null;
			const fast = fastRoc[i];
			const slow = slowRoc[i];
			if (fast === null || slow === null) return null;

			if (slow > 0 && fast < 0 && Math.abs(fast) > slow * p.phi_ratio)
				return createBuySignal(cleanData, i, "Proportional pullback in uptrend");
			if (slow < 0 && fast > 0 && Math.abs(fast) > Math.abs(slow) * p.phi_ratio)
				return createSellSignal(cleanData, i, "Proportional pullback in downtrend");
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["fast_lookback", "slow_lookback", "phi_ratio"],
	},
};
