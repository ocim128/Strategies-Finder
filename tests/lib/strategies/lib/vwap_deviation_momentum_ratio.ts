import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildDualTimeframeRatio } from "./price-action-statistics-core";
import { buildRollingAverage } from "./price-action-frequency-core";
import { calculateVWAP } from "../indicators";

function normalizeVwapDeviationMomentumRatioParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		fast_window: Math.max(2, Math.round(params.fast_window ?? 5)),
		slow_window: Math.max(3, Math.round(params.slow_window ?? 20)),
		spread: Math.min(1, Math.max(0.01, Number(params.spread ?? 0.2))),
	};
}

export const vwap_deviation_momentum_ratio: Strategy = {
	name: "VWAP Deviation Momentum Ratio",
	description: "The dual-timeframe ratio of the VWAP deviation — fast rolling average divided by slow rolling average — measures whether the recent value deviation is accelerating or decelerating relative to the baseline. Captures the turning point where VWAP deviation shifts.",
	defaultParams: {
		fast_window: 5,
		slow_window: 20,
		spread: 0.2,
	},
	paramLabels: {
		fast_window: "Fast Window",
		slow_window: "Slow Window",
		spread: "Spread",
	},
	normalizeParams: normalizeVwapDeviationMomentumRatioParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVwapDeviationMomentumRatioParams(params);
		if (cleanData.length < p.slow_window + 1) return [];

		const closes = getCloses(cleanData);
		const vwap = calculateVWAP(cleanData);
		const deviation: number[] = closes.map((c, i) => {
			const v = vwap[i];
			return v === null ? 0 : c - v;
		});
		const ratio = buildDualTimeframeRatio(deviation, p.fast_window, p.slow_window, buildRollingAverage);

		return createSignalLoop(cleanData, [ratio], (i) => {
			if (i < p.slow_window) return null;
			const r = ratio[i];
			if (r === null) return null;

			if (r < (1 - p.spread)) {
				return createBuySignal(cleanData, i, `VWAP deviation ratio ${r.toFixed(3)} below (1-spread) — discount accelerating`);
			}
			if (r > (1 + p.spread)) {
				return createSellSignal(cleanData, i, `VWAP deviation ratio ${r.toFixed(3)} above (1+spread) — premium accelerating`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["fast_window", "slow_window", "spread"],
	},
};
