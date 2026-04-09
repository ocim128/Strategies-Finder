import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { buildEfficiencyRatio, buildRollingZScore } from "./price-action-statistics-core";

function normalizeTrailingMinmaxEfficiencySqueezeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 20)),
		spread_z_max: Number(params.spread_z_max ?? -1.5),
		er_min: Math.max(0.01, Math.abs(Number(params.er_min ?? 0.5))) };
}

export const trailing_minmax_efficiency_squeeze: Strategy = {
	name: "Trailing MinMax Efficiency Squeeze",
	description: "When the trailing spread is severely compressed (negative Z-score) while path efficiency remains high, an impending violent directional expansion is signaled.",
	defaultParams: {
		lookback: 20,
		spread_z_max: -1.5,
		er_min: 0.5 },
	paramLabels: {
		lookback: "Lookback",
		spread_z_max: "Max Spread Z-Score",
		er_min: "Min Efficiency Ratio" },
	normalizeParams: normalizeTrailingMinmaxEfficiencySqueezeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeTrailingMinmaxEfficiencySqueezeParams(params);
		if (cleanData.length < p.lookback) return [];

		const closes = getCloses(cleanData);
		const er = buildEfficiencyRatio(cleanData, p.lookback);
		const { highest, lowest } = buildTrailingHighLow(cleanData, p.lookback);

		const spreads: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			const hi = highest[i];
			const lo = lowest[i];
			spreads[i] = (hi !== null && lo !== null) ? hi - lo : 0;
		}
		const spreadZ = buildRollingZScore(spreads, p.lookback);

		return createSignalLoop(cleanData, [er, spreadZ, highest, lowest], (i) => {
			if (i < p.lookback) return null;
			const erVal = er[i];
			const sz = spreadZ[i];
			const hi = highest[i];
			const lo = lowest[i];
			if (erVal === null || sz === null || hi === null || lo === null) return null;

			if (sz >= p.spread_z_max || erVal < p.er_min) return null;

			const midpoint = (hi + lo) / 2;
			if (closes[i] > midpoint) {
				return createBuySignal(cleanData, i, `Spread Z ${sz.toFixed(2)} < ${p.spread_z_max}, ER ${erVal.toFixed(3)} > ${p.er_min}, close above midpoint`);
			}
			if (closes[i] < midpoint) {
				return createSellSignal(cleanData, i, `Spread Z ${sz.toFixed(2)} < ${p.spread_z_max}, ER ${erVal.toFixed(3)} > ${p.er_min}, close below midpoint`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "spread_z_max", "er_min"] } };
