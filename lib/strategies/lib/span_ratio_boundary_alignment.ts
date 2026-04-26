import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
} from "../strategy-helpers";
import { buildRangeSeries, buildTrailingWindowSpan } from "./price-action-frequency-core";

function normalizeSpanRatioBoundaryAlignmentParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		span_lookback: Math.max(2, Math.round(params.span_lookback ?? 20)),
		consumption_threshold: Math.min(0.99, Math.max(0.01, Number(params.consumption_threshold ?? 0.4))),
	};
}

export const span_ratio_boundary_alignment: Strategy = {
	name: "Span Ratio Boundary Alignment",
	description: "The ratio of current bar's range to the trailing window span measures how much of the recent range the current bar is consuming. When a single bar consumes a large fraction of the trailing span, it indicates a boundary breach with participation. The body direction gives the trade side.",
	defaultParams: {
		span_lookback: 20,
		consumption_threshold: 0.4,
	},
	paramLabels: {
		span_lookback: "Span Lookback",
		consumption_threshold: "Consumption Threshold",
	},
	normalizeParams: normalizeSpanRatioBoundaryAlignmentParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeSpanRatioBoundaryAlignmentParams(params);
		if (cleanData.length < p.span_lookback) return [];

		const ranges = buildRangeSeries(cleanData);
		const trailingSpan = buildTrailingWindowSpan(cleanData, p.span_lookback);

		return createSignalLoop(cleanData, [trailingSpan], (i) => {
			if (i < p.span_lookback) return null;
			const span = trailingSpan[i];
			if (span === null || span <= 0) return null;

			const consumption = ranges[i] / span;
			if (consumption < p.consumption_threshold) return null;

			const bar = cleanData[i];
			if (bar.close > bar.open) {
				return createBuySignal(cleanData, i, `Bar consumes ${(consumption * 100).toFixed(1)}% of trailing span, bullish`);
			}
			if (bar.close < bar.open) {
				return createSellSignal(cleanData, i, `Bar consumes ${(consumption * 100).toFixed(1)}% of trailing span, bearish`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["span_lookback", "consumption_threshold"],
	},
};
