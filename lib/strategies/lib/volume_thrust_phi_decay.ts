import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildRateOfChange, buildRollingCorrelation, buildRollingMinMax } from "./price-action-statistics-core";

function normalizeVolumeThrustPhiDecayParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		corr_lookback: Math.max(3, Math.round(params.corr_lookback ?? 20)),
		phi_decay_ratio: Math.max(0.01, Math.min(0.99, Number(params.phi_decay_ratio ?? 0.382))),
	};
}

export const volume_thrust_phi_decay: Strategy = {
	name: "Volume Thrust Phi Decay",
	description: "A high correlation between volume and price returns that decays by 0.382 from its rolling maximum signals that the aggressive flow driving the thrust has completely exhausted.",
	defaultParams: {
		corr_lookback: 20,
		phi_decay_ratio: 0.382,
	},
	paramLabels: {
		corr_lookback: "Correlation Lookback",
		phi_decay_ratio: "Phi Decay Ratio",
	},
	normalizeParams: normalizeVolumeThrustPhiDecayParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVolumeThrustPhiDecayParams(params);
		if (cleanData.length < p.corr_lookback) return [];

		const closes = getCloses(cleanData);
		const volumes = getVolumes(cleanData);
		const roc = buildRateOfChange(closes, 1);
		const rocClean = roc.map(v => v ?? 0);
		const corr = buildRollingCorrelation(rocClean, volumes, p.corr_lookback);
		const corrClean = corr.map(v => v ?? 0);
		const corrMinMax = buildRollingMinMax(corrClean, p.corr_lookback);

		return createSignalLoop(cleanData, [corr, roc], (i) => {
			if (i < p.corr_lookback) return null;
			const corrVal = corr[i];
			const corrMax = corrMinMax.max[i];
			const rocVal = roc[i];
			if (corrVal === null || corrMax === null || rocVal === null) return null;

			const decayThreshold = corrMax * (1 - p.phi_decay_ratio);
			if (corrVal < decayThreshold && rocVal < 0)
				return createBuySignal(cleanData, i, "Volume correlation decay, selling exhausted");
			if (corrVal < decayThreshold && rocVal > 0)
				return createSellSignal(cleanData, i, "Volume correlation decay, buying exhausted");
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["corr_lookback", "phi_decay_ratio"],
	},
};
