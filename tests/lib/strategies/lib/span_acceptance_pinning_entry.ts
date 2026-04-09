import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildTrailingWindowSpan } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeSpanAcceptancePinningEntryParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		spanLookback: Math.max(2, Math.round(params.spanLookback ?? 30)),
		spanRankMax: Math.max(0, Math.min(100, Number(params.spanRankMax ?? 20))) };
}

export const span_acceptance_pinning_entry: Strategy = {
	name: "Span Acceptance Pinning Entry",
	description: "Narrow trailing span with consistently high close acceptance in one direction signals dealer pinning near a strike. Enter in the acceptance direction because the pinning flow is committed and the compressed span limits adverse excursion.",
	defaultParams: {
		spanLookback: 30,
		spanRankMax: 20 },
	paramLabels: {
		spanLookback: "Span Lookback",
		spanRankMax: "Span Rank Max" },
	normalizeParams: normalizeSpanAcceptancePinningEntryParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeSpanAcceptancePinningEntryParams(params);
		const spanLookback = p.spanLookback as number;
		const spanRankMax = p.spanRankMax as number;
		if (cleanData.length < spanLookback + 4) return [];

		const span = buildTrailingWindowSpan(cleanData, spanLookback);
		const spanClean = span.map(v => v ?? 0);
		const spanRank = buildPercentileRank(spanClean, spanLookback);
		const acceptance = buildCloseAcceptanceSeries(cleanData);

		return createSignalLoop(cleanData, [spanRank], (i) => {
			if (i < spanLookback + 3) return null;
			const rank = spanRank[i];
			if (rank === null || rank >= spanRankMax / 100) return null;

			let bullishConsecutive = 0;
			let bearishConsecutive = 0;
			for (let j = i; j >= Math.max(1, i - 10); j--) {
				if (acceptance[j] > 0.5) {
					bullishConsecutive++;
					if (bearishConsecutive > 0) break;
				} else if (acceptance[j] < -0.5) {
					bearishConsecutive++;
					if (bullishConsecutive > 0) break;
				} else {
					break;
				}
			}

			if (bullishConsecutive >= 3) {
				return createBuySignal(cleanData, i, `Span compressed (rank ${(rank * 100).toFixed(0)}%), ${bullishConsecutive} bars bullish acceptance — pinning long`);
			}
			if (bearishConsecutive >= 3) {
				return createSellSignal(cleanData, i, `Span compressed (rank ${(rank * 100).toFixed(0)}%), ${bearishConsecutive} bars bearish acceptance — pinning short`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["spanLookback", "spanRankMax"] } };
