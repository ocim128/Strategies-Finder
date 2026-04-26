import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildRollingEntropy, buildPercentileRank } from "./price-action-statistics-core";
import { calculateVWAP } from "../indicators";

function normalizeVwapDeviationEntropySqueezeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		entropy_window: Math.max(3, Math.round(params.entropy_window ?? 10)),
		squeeze_pct: Math.min(99, Math.max(1, Math.round(params.squeeze_pct ?? 20))),
	};
}

export const vwap_deviation_entropy_squeeze: Strategy = {
	name: "VWAP Deviation Entropy Squeeze",
	description: "The Shannon entropy of the close-to-VWAP deviation series measures how disordered the value-deviation behavior has been. When entropy drops to an extreme low, price has locked into a narrow band around VWAP — a value squeeze that resolves directionally.",
	defaultParams: {
		entropy_window: 10,
		squeeze_pct: 20,
	},
	paramLabels: {
		entropy_window: "Entropy Window",
		squeeze_pct: "Squeeze Percentile Max",
	},
	normalizeParams: normalizeVwapDeviationEntropySqueezeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVwapDeviationEntropySqueezeParams(params);
		const pctWindow = Math.max(p.entropy_window * 3, 20);
		if (cleanData.length < pctWindow) return [];

		const closes = getCloses(cleanData);
		const vwap = calculateVWAP(cleanData);
		const deviation: number[] = closes.map((c, i) => {
			const v = vwap[i];
			return v === null ? 0 : c - v;
		});
		const entropy = buildRollingEntropy(deviation, p.entropy_window);
		const entropyClean: number[] = entropy.map((v) => (v === null ? 999 : v));
		const entropyPct = buildPercentileRank(entropyClean, pctWindow);
		const squeezePctMax = p.squeeze_pct / 100;

		return createSignalLoop(cleanData, [entropyPct], (i) => {
			if (i < pctWindow) return null;
			const ep = entropyPct[i];
			if (ep === null) return null;
			if (ep > squeezePctMax) return null;

			const bar = cleanData[i];
			if (bar.close > bar.open) {
				return createBuySignal(cleanData, i, `VWAP deviation squeeze (entropy pct ${ep.toFixed(3)}) resolving bullish`);
			}
			if (bar.close < bar.open) {
				return createSellSignal(cleanData, i, `VWAP deviation squeeze (entropy pct ${ep.toFixed(3)}) resolving bearish`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["entropy_window", "squeeze_pct"],
	},
};
