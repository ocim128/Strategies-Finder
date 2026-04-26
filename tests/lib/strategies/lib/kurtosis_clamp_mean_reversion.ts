import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import {
	buildRollingKurtosis,
	buildRateOfChange,
	extractBarMetricSeries,
} from "./price-action-statistics-core";
import { buildRollingAverage } from "./price-action-frequency-core";

function normalizeKurtosisClampMeanReversionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		kurtosis_window: Math.max(5, Math.round(params.kurtosis_window ?? 20)),
		roc_threshold: Number(params.roc_threshold ?? -0.3),
	};
}

export const kurtosis_clamp_mean_reversion: Strategy = {
	name: "Kurtosis Clamp Mean Reversion",
	description: "Excess kurtosis measures how fat-tailed the return distribution has become. A sharp drop in kurtosis means the distribution has clamped to normal — the fat-tail event is over. Fade the directional exhaustion by entering against the trailing return direction.",
	defaultParams: {
		kurtosis_window: 20,
		roc_threshold: -0.3,
	},
	paramLabels: {
		kurtosis_window: "Kurtosis Window",
		roc_threshold: "Kurtosis ROC Threshold",
	},
	normalizeParams: normalizeKurtosisClampMeanReversionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeKurtosisClampMeanReversionParams(params);
		if (cleanData.length < p.kurtosis_window + 1) return [];

		const returns = extractBarMetricSeries(cleanData, "closeReturn");
		const kurtosis = buildRollingKurtosis(returns, p.kurtosis_window);
		const kurtosisValues: number[] = kurtosis.map((v) => (v === null ? 0 : v));
		const kurtosisRoc = buildRateOfChange(kurtosisValues, 1);
		const avgReturn = buildRollingAverage(returns, p.kurtosis_window);

		return createSignalLoop(cleanData, [kurtosisRoc, avgReturn], (i) => {
			if (i < p.kurtosis_window) return null;
			const kr = kurtosisRoc[i];
			const avg = avgReturn[i];
			if (kr === null || avg === null) return null;

			if (kr < p.roc_threshold && avg < 0) {
				return createBuySignal(cleanData, i, `Kurtosis clamping (${kr.toFixed(3)}) after bearish drift — fade`);
			}
			if (kr < p.roc_threshold && avg > 0) {
				return createSellSignal(cleanData, i, `Kurtosis clamping (${kr.toFixed(3)}) after bullish drift — fade`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["kurtosis_window", "roc_threshold"],
	},
};
