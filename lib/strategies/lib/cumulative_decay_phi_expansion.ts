import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCumulativeDecaySum, buildRateOfChange } from "./price-action-statistics-core";

function normalizeCumulativeDecayPhiExpansionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		roc_lookback: Math.max(1, Math.round(params.roc_lookback ?? 5)),
		decay_factor: Math.max(0.01, Math.min(0.999, Number(params.decay_factor ?? 0.382))),
		sum_thresh: Math.max(0.1, Number(params.sum_thresh ?? 3.0)),
	};
}

export const cumulative_decay_phi_expansion: Strategy = {
	name: "Cumulative Decay Phi Expansion",
	description: "A fast rate-of-change smoothed by a golden decay factor acts as a high-memory oscillator, exposing persistent institutional sponsorship that standard momentum misses.",
	defaultParams: {
		roc_lookback: 5,
		decay_factor: 0.382,
		sum_thresh: 3.0,
	},
	paramLabels: {
		roc_lookback: "ROC Lookback",
		decay_factor: "Decay Factor",
		sum_thresh: "Sum Threshold",
	},
	normalizeParams: normalizeCumulativeDecayPhiExpansionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeCumulativeDecayPhiExpansionParams(params);
		if (cleanData.length < p.roc_lookback) return [];

		const closes = getCloses(cleanData);
		const roc = buildRateOfChange(closes, p.roc_lookback);
		const rocClean = roc.map(v => v ?? 0);
		const decayed = buildCumulativeDecaySum(rocClean, p.decay_factor);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < p.roc_lookback) return null;
			if (decayed[i] > p.sum_thresh) return createBuySignal(cleanData, i, `Decayed momentum > ${p.sum_thresh}`);
			if (decayed[i] < -p.sum_thresh) return createSellSignal(cleanData, i, `Decayed momentum < -${p.sum_thresh}`);
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["roc_lookback", "decay_factor", "sum_thresh"],
	},
};
