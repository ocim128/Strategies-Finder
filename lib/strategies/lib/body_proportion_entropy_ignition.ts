import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingEntropy, buildRateOfChange } from "./price-action-statistics-core";

function normalizeBodyProportionEntropyIgnitionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		entropy_window: Math.max(3, Math.round(params.entropy_window ?? 10)),
		implosion_threshold: Math.max(-5, Math.min(-0.01, Number(params.implosion_threshold ?? -0.4))),
	};
}

export const body_proportion_entropy_ignition: Strategy = {
	name: "Body Proportion Entropy Ignition",
	description: "A sudden collapse in body percentage entropy means algorithmic execution is printing mechanically identical bars. This ignition signals a systematic move.",
	defaultParams: {
		entropy_window: 10,
		implosion_threshold: -0.4,
	},
	paramLabels: {
		entropy_window: "Entropy Window",
		implosion_threshold: "Implosion Threshold",
	},
	normalizeParams: normalizeBodyProportionEntropyIgnitionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeBodyProportionEntropyIgnitionParams(params);
		if (cleanData.length < p.entropy_window + 2) return [];

		const bodyPct = extractBarMetricSeries(cleanData, 'bodyPct');
		const entropy = buildRollingEntropy(bodyPct, p.entropy_window);
		const entropyClean = entropy.map(v => v ?? 0);
		const entropyRoc = buildRateOfChange(entropyClean, 1);

		return createSignalLoop(cleanData, [entropyRoc], (i) => {
			if (i < p.entropy_window + 1) return null;
			const roc = entropyRoc[i];
			if (roc === null) return null;

			if (roc < p.implosion_threshold) {
				if (cleanData[i].close > cleanData[i].open) {
					return createBuySignal(cleanData, i, `Body entropy implosion (ROC ${roc.toFixed(2)}), bullish bar`);
				}
				if (cleanData[i].close < cleanData[i].open) {
					return createSellSignal(cleanData, i, `Body entropy implosion (ROC ${roc.toFixed(2)}), bearish bar`);
				}
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["entropy_window", "implosion_threshold"],
	},
};





