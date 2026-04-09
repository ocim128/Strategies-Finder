import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingKurtosis, buildRollingMedian, buildRateOfChange, buildEfficiencyRatio } from "./price-action-statistics-core";

function normalizeKurtosisEfficiencyRegimeShiftParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(4, Math.round(params.lookback ?? 30)),
		kurtosis_max: Math.max(0.01, Math.abs(Number(params.kurtosis_max ?? 0.5))),
		er_min: Math.max(0.01, Math.abs(Number(params.er_min ?? 0.6))) };
}

export const kurtosis_efficiency_regime_shift: Strategy = {
	name: "Kurtosis Efficiency Regime Shift",
	description: "A drop in rolling kurtosis combined with high efficiency signals a transition from fat-tailed chop to a clean directional trend.",
	defaultParams: {
		lookback: 30,
		kurtosis_max: 0.5,
		er_min: 0.6 },
	paramLabels: {
		lookback: "Lookback",
		kurtosis_max: "Max Kurtosis",
		er_min: "Min Efficiency Ratio" },
	normalizeParams: normalizeKurtosisEfficiencyRegimeShiftParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeKurtosisEfficiencyRegimeShiftParams(params);
		if (cleanData.length < p.lookback) return [];

		const closes = getCloses(cleanData);
		const returns = buildRateOfChange(closes, 1);
		const returnValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			returnValues[i] = returns[i] ?? 0;
		}
		const kurtosis = buildRollingKurtosis(returnValues, p.lookback);
		const er = buildEfficiencyRatio(cleanData, p.lookback);
		const median = buildRollingMedian(closes, p.lookback);

		return createSignalLoop(cleanData, [kurtosis, er, median], (i) => {
			if (i < p.lookback) return null;
			const k = kurtosis[i];
			const e = er[i];
			const m = median[i];
			if (k === null || e === null || m === null) return null;

			if (k < p.kurtosis_max && e > p.er_min && closes[i] > m) {
				return createBuySignal(cleanData, i, `Kurtosis ${k.toFixed(3)} < ${p.kurtosis_max}, ER ${e.toFixed(3)} > ${p.er_min}, close above median`);
			}
			if (k < p.kurtosis_max && e > p.er_min && closes[i] < m) {
				return createSellSignal(cleanData, i, `Kurtosis ${k.toFixed(3)} < ${p.kurtosis_max}, ER ${e.toFixed(3)} > ${p.er_min}, close below median`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "kurtosis_max", "er_min"] } };
