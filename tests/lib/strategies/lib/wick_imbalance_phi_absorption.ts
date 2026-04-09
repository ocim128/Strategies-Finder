import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeWickImbalancePhiAbsorptionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 10)),
		phi_imbalance: Math.max(0, Math.min(1, Number(params.phi_imbalance ?? 0.382))),
		phi_compression: Math.max(0, Math.min(1, Number(params.phi_compression ?? 0.382))),
	};
}

export const wick_imbalance_phi_absorption: Strategy = {
	name: "Wick Imbalance Phi Absorption",
	description: "Rolling wick imbalance exceeding 0.382 while body proportion compresses below 0.382 confirms passive iceberg order absorbing all incoming flow.",
	defaultParams: {
		lookback: 10,
		phi_imbalance: 0.382,
		phi_compression: 0.382,
	},
	paramLabels: {
		lookback: "Lookback",
		phi_imbalance: "Phi Imbalance",
		phi_compression: "Phi Compression",
	},
	normalizeParams: normalizeWickImbalancePhiAbsorptionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeWickImbalancePhiAbsorptionParams(params);
		if (cleanData.length < p.lookback) return [];

		const wickImbalance = extractBarMetricSeries(cleanData, "wickImbalance");
		const bodyPct = extractBarMetricSeries(cleanData, "bodyPct");
		const rollingWI = buildRollingAverage(wickImbalance, p.lookback);
		const rollingBP = buildRollingAverage(bodyPct, p.lookback);

		return createSignalLoop(cleanData, [rollingWI, rollingBP], (i) => {
			const wi = rollingWI[i];
			const bp = rollingBP[i];
			if (wi === null || bp === null) return null;
			if (wi > p.phi_imbalance && bp < p.phi_compression)
				return createBuySignal(cleanData, i, "Wick imbalance bullish absorption");
			if (wi < -p.phi_imbalance && bp < p.phi_compression)
				return createSellSignal(cleanData, i, "Wick imbalance bearish absorption");
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "phi_imbalance", "phi_compression"],
	},
};
