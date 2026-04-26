import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import {
	extractBarMetricSeries,
	buildPercentileRank,
} from "./price-action-statistics-core";

function normalizeGapPctReversalAlignmentParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(5, Math.round(params.lookback ?? 60)),
		percentile_threshold: Math.min(0.99, Math.max(0.5, Number(params.percentile_threshold ?? 0.9))),
	};
}

export const gap_pct_reversal_alignment: Strategy = {
	name: "Gap Percentile Reversal Alignment",
	description: "The gap percentage between consecutive bars is a direct measure of interbar price jump. When the absolute gap percentile reaches an extreme, a gap-fade entry captures the mean-reversion of excessive gaps.",
	defaultParams: {
		lookback: 60,
		percentile_threshold: 0.9,
	},
	paramLabels: {
		lookback: "Lookback",
		percentile_threshold: "Percentile Threshold",
	},
	normalizeParams: normalizeGapPctReversalAlignmentParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeGapPctReversalAlignmentParams(params);
		if (cleanData.length < p.lookback + 1) return [];

		const gapPct = extractBarMetricSeries(cleanData, "gapPct");
		const absGap = gapPct.map((v) => Math.abs(v));
		const rank = buildPercentileRank(absGap, p.lookback);

		return createSignalLoop(cleanData, [rank], (i) => {
			if (i < p.lookback || i < 1) return null;
			const r = rank[i];
			if (r === null) return null;
			if (r <= p.percentile_threshold) return null;

			const isGapUp = cleanData[i].open > cleanData[i - 1].close;
			const isGapDown = cleanData[i].open < cleanData[i - 1].close;

			if (isGapDown) {
				return createBuySignal(cleanData, i, `Extreme gap down at percentile ${r.toFixed(3)} — fade bearish gap`);
			}
			if (isGapUp) {
				return createSellSignal(cleanData, i, `Extreme gap up at percentile ${r.toFixed(3)} — fade bullish gap`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "percentile_threshold"],
	},
};
