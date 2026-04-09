import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildRollingKurtosis } from "./price-action-statistics-core";

function normalizeKurtosisPhiRegimeLaunchParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(4, Math.round(params.lookback ?? 40)),
		kurtosis_floor: Math.max(-10, Number(params.kurtosis_floor ?? 0.382)),
		roc_min: Math.max(0, Number(params.roc_min ?? 1.5)),
	};
}

export const kurtosis_phi_regime_launch: Strategy = {
	name: "Kurtosis Phi Regime Launch",
	description: "A structural plunge in kurtosis below 0.382 confirms the end of a fat-tailed chop environment. A simultaneous momentum thrust ignites a high-conviction trend.",
	defaultParams: {
		lookback: 40,
		kurtosis_floor: 0.382,
		roc_min: 1.5,
	},
	paramLabels: {
		lookback: "Lookback",
		kurtosis_floor: "Kurtosis Floor",
		roc_min: "ROC Min",
	},
	normalizeParams: normalizeKurtosisPhiRegimeLaunchParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeKurtosisPhiRegimeLaunchParams(params);
		if (cleanData.length < p.lookback) return [];

		const closes = getCloses(cleanData);
		const kurtosis = buildRollingKurtosis(closes, p.lookback);
		const roc = buildRateOfChange(closes, 1);

		return createSignalLoop(cleanData, [kurtosis, roc], (i) => {
			if (i < p.lookback) return null;
			const k = kurtosis[i];
			const r = roc[i];
			if (k === null || r === null) return null;
			if (k >= p.kurtosis_floor) return null;

			if (r > p.roc_min) return createBuySignal(cleanData, i, "Kurtosis collapse with bullish thrust");
			if (r < -p.roc_min) return createSellSignal(cleanData, i, "Kurtosis collapse with bearish thrust");
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "kurtosis_floor", "roc_min"],
	},
};
