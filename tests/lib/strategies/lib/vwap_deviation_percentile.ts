import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
} from "../strategy-helpers";
import { buildPercentileRank } from "./price-action-statistics-core";
import { calculateVWAP } from "../indicators";

function normalizeVwapDeviationPercentileParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 30)),
		upper_pct: Math.min(0.99, Math.max(0.5, Number(params.upper_pct ?? 0.85))),
		lower_pct: Math.min(0.5, Math.max(0.01, Number(params.lower_pct ?? 0.15))),
	};
}

export const vwap_deviation_percentile: Strategy = {
	name: "VWAP Deviation Percentile",
	description: "The percentile rank of the signed close-to-VWAP deviation within its trailing window directly measures distributional extremity. Percentile rank handles non-normal, fat-tailed deviation distributions better than z-score.",
	defaultParams: {
		lookback: 30,
		upper_pct: 0.85,
		lower_pct: 0.15,
	},
	paramLabels: {
		lookback: "Lookback",
		upper_pct: "Upper Percentile",
		lower_pct: "Lower Percentile",
	},
	normalizeParams: normalizeVwapDeviationPercentileParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeVwapDeviationPercentileParams(params);
		if (cleanData.length < p.lookback) return [];

		const closes = getCloses(cleanData);
		const vwap = calculateVWAP(cleanData);
		const deviation: number[] = closes.map((c, i) => {
			const v = vwap[i];
			return v === null ? 0 : c - v;
		});
		const rank = buildPercentileRank(deviation, p.lookback);

		return createSignalLoop(cleanData, [rank], (i) => {
			if (i < p.lookback) return null;
			const r = rank[i];
			if (r === null) return null;

			if (r < p.lower_pct) {
				return createBuySignal(cleanData, i, `VWAP deviation percentile ${r.toFixed(3)} below lower threshold (discount tail)`);
			}
			if (r > p.upper_pct) {
				return createSellSignal(cleanData, i, `VWAP deviation percentile ${r.toFixed(3)} above upper threshold (premium tail)`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "upper_pct", "lower_pct"],
	},
};
