import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildEfficiencyRatio } from "./price-action-statistics-core";

function normalizeMacroMicroEfficiencySyncParams(params: StrategyParams): StrategyParams {
	const fast_window = Math.max(2, Math.round(params.fast_window ?? 10));
	const slow_window = Math.max(3, Math.round(params.slow_window ?? 50));
	return {
		...params,
		fast_window,
		slow_window: Math.max(slow_window, fast_window + 1),
		ratio_min: Math.max(0.01, Math.abs(Number(params.ratio_min ?? 1.5))) };
}

export const macro_micro_efficiency_sync: Strategy = {
	name: "Macro Micro Efficiency Sync",
	description: "When micro efficiency bursts above a multiple of macro efficiency while macro ER is elevated, a fractal trend alignment continuation is triggered.",
	defaultParams: {
		fast_window: 10,
		slow_window: 50,
		ratio_min: 1.5 },
	paramLabels: {
		fast_window: "Fast Window",
		slow_window: "Slow Window",
		ratio_min: "Min ER Ratio" },
	normalizeParams: normalizeMacroMicroEfficiencySyncParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeMacroMicroEfficiencySyncParams(params);
		if (cleanData.length < p.slow_window) return [];

		const fastER = buildEfficiencyRatio(cleanData, p.fast_window);
		const slowER = buildEfficiencyRatio(cleanData, p.slow_window);

		const ratio: (number | null)[] = new Array(cleanData.length).fill(null);
		for (let i = 0; i < cleanData.length; i++) {
			const f = fastER[i];
			const s = slowER[i];
			if (f !== null && s !== null && s > 0) {
				ratio[i] = f / s;
			}
		}

		return createSignalLoop(cleanData, [ratio, slowER], (i) => {
			if (i < p.slow_window) return null;
			const r = ratio[i];
			const s = slowER[i];
			if (r === null || s === null) return null;

			if (r > p.ratio_min && s > 0.4 && cleanData[i].close > cleanData[i].open) {
				return createBuySignal(cleanData, i, `ER ratio ${r.toFixed(3)} > ${p.ratio_min}, slow ER ${s.toFixed(3)} > 0.4, bullish sync`);
			}
			if (r > p.ratio_min && s > 0.4 && cleanData[i].close < cleanData[i].open) {
				return createSellSignal(cleanData, i, `ER ratio ${r.toFixed(3)} > ${p.ratio_min}, slow ER ${s.toFixed(3)} > 0.4, bearish sync`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["fast_window", "slow_window", "ratio_min"] } };
