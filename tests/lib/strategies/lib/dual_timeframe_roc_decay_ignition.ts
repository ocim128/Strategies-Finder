import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildCumulativeDecaySum } from "./price-action-statistics-core";

function normalizeDualTimeframeRocDecayIgnitionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		fast_roc: Math.max(1, Math.round(params.fast_roc ?? 3)),
		slow_roc: Math.max(2, Math.round(params.slow_roc ?? 50)),
		decay_thresh: Math.max(0.01, Math.abs(Number(params.decay_thresh ?? 2.0))) };
}

export const dual_timeframe_roc_decay_ignition: Strategy = {
	name: "Dual Timeframe ROC Decay Ignition",
	description: "Applying a cumulative decay sum to fast ROC uncovers hidden persistent momentum bursts that trigger entries when aligned with a highly directional slow ROC.",
	defaultParams: {
		fast_roc: 3,
		slow_roc: 50,
		decay_thresh: 2.0 },
	paramLabels: {
		fast_roc: "Fast ROC Window",
		slow_roc: "Slow ROC Window",
		decay_thresh: "Decay Threshold" },
	normalizeParams: normalizeDualTimeframeRocDecayIgnitionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeDualTimeframeRocDecayIgnitionParams(params);
		if (cleanData.length < p.slow_roc) return [];

		const closes = getCloses(cleanData);
		const fastRoc = buildRateOfChange(closes, p.fast_roc);
		const fastRocValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			fastRocValues[i] = fastRoc[i] ?? 0;
		}
		const decayedFast = buildCumulativeDecaySum(fastRocValues, 0.8);
		const slowRoc = buildRateOfChange(closes, p.slow_roc);

		return createSignalLoop(cleanData, [slowRoc], (i) => {
			if (i < p.slow_roc) return null;
			const sr = slowRoc[i];
			if (sr === null) return null;

			if (decayedFast[i] > p.decay_thresh && sr > 0) {
				return createBuySignal(cleanData, i, `Decayed fast ROC ${decayedFast[i].toFixed(3)} > ${p.decay_thresh}, slow ROC ${sr.toFixed(4)} > 0`);
			}
			if (decayedFast[i] < -p.decay_thresh && sr < 0) {
				return createSellSignal(cleanData, i, `Decayed fast ROC ${decayedFast[i].toFixed(3)} < -${p.decay_thresh}, slow ROC ${sr.toFixed(4)} < 0`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["fast_roc", "slow_roc", "decay_thresh"] } };
