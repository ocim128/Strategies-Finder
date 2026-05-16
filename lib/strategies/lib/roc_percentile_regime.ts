import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildPercentileRank } from "./price-action-statistics-core";

function normalizeRocPercentileRegimeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		roc_period: Math.max(1, Math.round(params.roc_period ?? 5)),
		lookback: Math.max(5, Math.round(params.lookback ?? 50)),
		upper_pct: Math.max(0.5, Math.min(0.99, Number(params.upper_pct ?? 0.7))),
		lower_pct: Math.max(0.01, Math.min(0.5, Number(params.lower_pct ?? 0.3))),
	};
}

export const roc_percentile_regime: Strategy = {
	name: "ROC Percentile Regime",
	description: "Percentile rank of the current rate of change measures how extreme momentum is relative to recent history. High-percentile ROC indicates unusually strong upward momentum.",
	defaultParams: {
		roc_period: 5,
		lookback: 50,
		upper_pct: 0.7,
		lower_pct: 0.3,
	},
	paramLabels: {
		roc_period: "ROC Period",
		lookback: "Lookback",
		upper_pct: "Upper Percentile",
		lower_pct: "Lower Percentile",
	},
	normalizeParams: normalizeRocPercentileRegimeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const p = normalizeRocPercentileRegimeParams(params);
		const rocPeriod = p.roc_period as number;
		const lookback = p.lookback as number;
		const minWarmup = rocPeriod + lookback;
		if (data.length < minWarmup + 2) return [];

		const closes = getCloses(data);
		const roc = buildRateOfChange(closes, rocPeriod);
		const rocRank = buildPercentileRank(
			roc.map(v => v ?? 0),
			lookback
		);

		return createSignalLoop(data, [rocRank], (i) => {
			if (i < minWarmup) return null;
			const r = rocRank[i];
			if (r === null) return null;

			if (r > p.upper_pct) {
				return createBuySignal(data, i, `ROC percentile ${(r * 100).toFixed(0)}% (upper tail momentum)`);
			}
			if (r < p.lower_pct) {
				return createSellSignal(data, i, `ROC percentile ${(r * 100).toFixed(0)}% (lower tail momentum)`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["roc_period", "lookback", "upper_pct", "lower_pct"],
	},
};





