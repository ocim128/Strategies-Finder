import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildTrailingWindowSpan, buildTrailingHighLow } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeTrailingSpanCompressionBreakoutParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		spanLookback: Math.max(2, Math.round(params.spanLookback ?? 30)),
		compressionRank: Math.max(0, Math.min(100, Number(params.compressionRank ?? 15))) };
}

export const trailing_span_compression_breakout: Strategy = {
	name: "Trailing Span Compression Breakout",
	description: "When the trailing high-low span compresses to a percentile extreme low, all participants have converged on a narrow consensus. A close escaping that compressed window is a structural break from consensus. Enter in the breakout direction.",
	defaultParams: {
		spanLookback: 30,
		compressionRank: 15 },
	paramLabels: {
		spanLookback: "Span Lookback",
		compressionRank: "Compression Rank Max" },
	normalizeParams: normalizeTrailingSpanCompressionBreakoutParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeTrailingSpanCompressionBreakoutParams(params);
		const lookback = p.spanLookback as number;
		const rankMax = p.compressionRank as number;
		if (cleanData.length < lookback + 2) return [];

		const closes = getCloses(cleanData);
		const span = buildTrailingWindowSpan(cleanData, lookback);
		const spanClean = span.map(v => v ?? 0);
		const rank = buildPercentileRank(spanClean, lookback);
		const { highest, lowest } = buildTrailingHighLow(cleanData, lookback);

		return createSignalLoop(cleanData, [rank, highest, lowest], (i) => {
			if (i < lookback) return null;
			const r = rank[i];
			const hi = highest[i];
			const lo = lowest[i];
			if (r === null || hi === null || lo === null) return null;
			if (r >= rankMax / 100) return null;

			if (closes[i] > hi) {
				return createBuySignal(cleanData, i, `Span compressed (rank ${(r * 100).toFixed(0)}%), close broke above trailing high`);
			}
			if (closes[i] < lo) {
				return createSellSignal(cleanData, i, `Span compressed (rank ${(r * 100).toFixed(0)}%), close broke below trailing low`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["spanLookback", "compressionRank"] } };
