import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildDualTimeframeRatio } from "./price-action-statistics-core";
import { buildRangeSeries, buildRollingAverage } from "./price-action-frequency-core";

function normalizeDualTimeframeRangeCompressionBreakParams(params: StrategyParams): StrategyParams {
	const fastWindow = Math.max(2, Math.round(params.fastWindow ?? 5));
	const slowWindow = Math.max(fastWindow + 1, Math.round(params.slowWindow ?? 30));
	const compressionThreshold = Math.min(0.9, Math.max(0.1, Number(params.compressionThreshold ?? 0.5)));
	return { ...params, fastWindow, slowWindow, compressionThreshold };
}

export const dual_timeframe_range_compression_break: Strategy = {
	name: "Dual Timeframe Range Compression Break",
	description:
		"When short-window range collapses relative to long-window range (fast range / slow range drops very low), the market is compressing at a micro scale while macro volatility remains elevated. This divergence resolves with a sharp directional move because the compression indicates temporary equilibrium that cannot persist within the broader volatility regime.",
	defaultParams: { fastWindow: 5, slowWindow: 30, compressionThreshold: 0.5 },
	paramLabels: { fastWindow: "Fast Window", slowWindow: "Slow Window", compressionThreshold: "Compression Threshold" },
	normalizeParams: normalizeDualTimeframeRangeCompressionBreakParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeDualTimeframeRangeCompressionBreakParams(params);
		if (cleanData.length < np.slowWindow + 2) return [];
		const closes = getCloses(cleanData);
		const ranges = buildRangeSeries(cleanData);
		const ratio = buildDualTimeframeRatio(ranges, np.fastWindow, np.slowWindow, buildRollingAverage);
		return createSignalLoop(cleanData, [ratio], (i) => {
			const r = ratio[i];
			if (r === null) return null;
			if (r < np.compressionThreshold && closes[i] > closes[i - 1])
				return createBuySignal(cleanData, i, `Range compression ratio ${r.toFixed(3)} < ${np.compressionThreshold}, upward resolution`);
			if (r < np.compressionThreshold && closes[i] < closes[i - 1])
				return createSellSignal(cleanData, i, `Range compression ratio ${r.toFixed(3)} < ${np.compressionThreshold}, downward resolution`);
			return null;
		});
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["fastWindow", "slowWindow", "compressionThreshold"] } };
