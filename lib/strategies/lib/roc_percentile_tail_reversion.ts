import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		rocLookback: Math.max(1, Math.round(Number(params.rocLookback ?? 5))),
		lookback: Math.max(2, Math.round(Number(params.lookback ?? 50))),
		extremeThreshold: Math.max(0.51, Math.min(0.99, Number(params.extremeThreshold ?? 0.95))),
	};
}

export const roc_percentile_tail_reversion: Strategy = {
	name: "ROC Percentile Tail Reversion",
	description: "Fades the ratio when its rate of change (ROC) reaches extreme historical percentiles.",
	defaultParams: {
		rocLookback: 5,
		lookback: 50,
		extremeThreshold: 0.95,
	},
	paramLabels: {
		rocLookback: "ROC Period",
		lookback: "Percentile Window",
		extremeThreshold: "Extreme Threshold",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeParams(params);
		const rocLookback = p.rocLookback as number;
		const lookback = p.lookback as number;
		const extremeThreshold = p.extremeThreshold as number;
		if (cleanData.length < lookback + rocLookback) return [];

		const closes = getCloses(cleanData);
		const roc = buildRateOfChange(closes, rocLookback);
		const cleanRoc = roc.map(v => v !== null ? v : 0);
		const rocPercentile = buildPercentileRank(cleanRoc, lookback);

		return createSignalLoop(cleanData, [rocPercentile], (i) => {
			if (i < lookback + rocLookback) return null;
			const pct = rocPercentile[i];
			if (pct === null) return null;

			if (pct <= (1 - extremeThreshold)) {
				return createBuySignal(cleanData, i, `ROC percentile (${pct.toFixed(2)}) is in lower extreme tail (<= ${(1 - extremeThreshold).toFixed(2)})`);
			}
			if (pct >= extremeThreshold) {
				return createSellSignal(cleanData, i, `ROC percentile (${pct.toFixed(2)}) is in upper extreme tail (>= ${extremeThreshold.toFixed(2)})`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["rocLookback", "lookback", "extremeThreshold"],
	},
};
