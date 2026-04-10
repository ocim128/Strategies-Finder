import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getWeightedClosePrices } from "../strategy-helpers";
import { buildRollingEntropy, buildRateOfChange } from "./price-action-statistics-core";

function normalizeVolumeWeightedEntropyIgnitionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		entropy_window: Math.max(3, Math.round(params.entropy_window ?? 6)),
		roc_threshold: Math.min(-0.01, Number(params.roc_threshold ?? -0.3)),
	};
}

export const volume_weighted_entropy_ignition: Strategy = {
	name: "Volume Weighted Entropy Ignition",
	description:
		"Entropy of the volume-weighted close measures the disorder of liquidity. A sudden drop in this entropy means random algorithmic noise has synchronized, igniting directional flow.",
	defaultParams: {
		entropy_window: 6,
		roc_threshold: -0.3,
	},
	paramLabels: {
		entropy_window: "Entropy Window",
		roc_threshold: "Entropy ROC Threshold",
	},
	normalizeParams: normalizeVolumeWeightedEntropyIgnitionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVolumeWeightedEntropyIgnitionParams(params);
		if (cleanData.length < (p.entropy_window as number) + 3) return [];

		const weightedClose = getWeightedClosePrices(cleanData);
		const entropy = buildRollingEntropy(weightedClose, p.entropy_window as number);
		const entropyClean = entropy.map(v => v ?? 0);
		const entropyRoc = buildRateOfChange(entropyClean, 1);

		return createSignalLoop(cleanData, [entropyRoc], (i) => {
			if (i < p.entropy_window + 1) return null;
			const eroc = entropyRoc[i];
			if (eroc === null) return null;

			if (eroc < p.roc_threshold && cleanData[i].close > cleanData[i].open) {
				return createBuySignal(
					cleanData,
					i,
					`Entropy ignition (long): entropy ROC=${eroc.toFixed(3)}`
				);
			}
			if (eroc < p.roc_threshold && cleanData[i].close < cleanData[i].open) {
				return createSellSignal(
					cleanData,
					i,
					`Entropy ignition (short): entropy ROC=${eroc.toFixed(3)}`
				);
			}

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["entropy_window", "roc_threshold"],
	},
};
