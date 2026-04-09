import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { extractBarMetricSeries, buildRollingEntropy } from "./price-action-statistics-core";
import { buildRollingAverage } from "./price-action-frequency-core";

function normalizeWickImbalancePhiEntropyParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		entropy_lookback: Math.max(3, Math.round(params.entropy_lookback ?? 20)),
		phi_entropy: Math.max(0.01, Math.abs(Number(params.phi_entropy ?? 0.382))) };
}

export const wick_imbalance_phi_entropy: Strategy = {
	name: "Wick Imbalance Phi Entropy",
	description: "When rolling entropy of wick imbalance drops below the golden ratio, tail rejections are occurring with mathematical predictability, exposing persistent algorithmic defense.",
	defaultParams: {
		entropy_lookback: 20,
		phi_entropy: 0.382 },
	paramLabels: {
		entropy_lookback: "Entropy Lookback",
		phi_entropy: "Phi Entropy" },
	normalizeParams: normalizeWickImbalancePhiEntropyParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeWickImbalancePhiEntropyParams(params);
		if (cleanData.length < p.entropy_lookback) return [];

		const wickImbalance = extractBarMetricSeries(cleanData, "wickImbalance");
		const entropy = buildRollingEntropy(wickImbalance, p.entropy_lookback);
		const smoothedImbalance = buildRollingAverage(wickImbalance, p.entropy_lookback);

		return createSignalLoop(cleanData, [entropy, smoothedImbalance], (i) => {
			if (i < p.entropy_lookback) return null;
			const ent = entropy[i];
			const avg = smoothedImbalance[i];
			if (ent === null || avg === null) return null;

			if (ent < p.phi_entropy && avg > 0) {
				return createBuySignal(cleanData, i, `Wick entropy ${ent.toFixed(3)} < phi, smoothed imbalance ${avg.toFixed(3)} > 0`);
			}
			if (ent < p.phi_entropy && avg < 0) {
				return createSellSignal(cleanData, i, `Wick entropy ${ent.toFixed(3)} < phi, smoothed imbalance ${avg.toFixed(3)} < 0`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["entropy_lookback", "phi_entropy"] } };
