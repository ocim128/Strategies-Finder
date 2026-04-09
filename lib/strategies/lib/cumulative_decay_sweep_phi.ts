import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildSweepReclaimSeries } from "./price-action-frequency-core";
import { buildCumulativeDecaySum } from "./price-action-statistics-core";

function normalizeCumulativeDecaySweepPhiParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		sweep_lookback: Math.max(2, Math.round(params.sweep_lookback ?? 20)),
		phi_decay: Math.max(0.01, Math.min(0.999, Number(params.phi_decay ?? 0.382))),
		fail_thresh: Math.max(0.1, Number(params.fail_thresh ?? 2.5)),
	};
}

export const cumulative_decay_sweep_phi: Strategy = {
	name: "Cumulative Decay Sweep Phi",
	description: "Applies a golden ratio decay to raw sweep-and-reclaim data, isolating persistent high-memory auction failures while filtering transient stop-runs.",
	defaultParams: {
		sweep_lookback: 20,
		phi_decay: 0.382,
		fail_thresh: 2.5,
	},
	paramLabels: {
		sweep_lookback: "Sweep Lookback",
		phi_decay: "Phi Decay",
		fail_thresh: "Failure Threshold",
	},
	normalizeParams: normalizeCumulativeDecaySweepPhiParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeCumulativeDecaySweepPhiParams(params);
		if (cleanData.length < p.sweep_lookback) return [];

		const sweepRaw = buildSweepReclaimSeries(cleanData, p.sweep_lookback);
		const sweepScores = sweepRaw.map(v => v ?? 0);
		const decayed = buildCumulativeDecaySum(sweepScores, p.phi_decay);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < p.sweep_lookback) return null;
			const val = decayed[i];
			if (val > p.fail_thresh) return createBuySignal(cleanData, i, `Decayed sweep > ${p.fail_thresh}`);
			if (val < -p.fail_thresh) return createSellSignal(cleanData, i, `Decayed sweep < -${p.fail_thresh}`);
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["sweep_lookback", "phi_decay", "fail_thresh"],
	},
};
