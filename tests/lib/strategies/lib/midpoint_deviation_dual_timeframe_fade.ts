import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { extractBarMetricSeries, buildRollingZScore, buildDualTimeframeRatio } from "./price-action-statistics-core";

function normalizeMidpointDeviationDualTimeframeFadeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		fastWindow: Math.max(2, Math.round(params.fastWindow ?? 5)),
		slowWindow: Math.max(2, Math.round(params.slowWindow ?? 40)) };
}

export const midpoint_deviation_dual_timeframe_fade: Strategy = {
	name: "Midpoint Deviation Dual Timeframe Fade",
	description: "Dual-timeframe ratio of closeMidpointDev captures whether short-term mispricing from fair value is accelerating relative to baseline. When the ratio z-score reaches an extreme and acceleration decelerates, the gamma cascade is losing momentum. Fade the acceleration direction.",
	defaultParams: {
		fastWindow: 5,
		slowWindow: 40 },
	paramLabels: {
		fastWindow: "Fast Window",
		slowWindow: "Slow Window" },
	normalizeParams: normalizeMidpointDeviationDualTimeframeFadeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeMidpointDeviationDualTimeframeFadeParams(params);
		const fastWindow = p.fastWindow as number;
		const slowWindow = p.slowWindow as number;
		if (cleanData.length < Math.max(fastWindow, slowWindow) + 52) return [];

		const devSeries = extractBarMetricSeries(cleanData, "closeMidpointDev");
		const devRatio = buildDualTimeframeRatio(devSeries, fastWindow, slowWindow, buildRollingAverage);
		const ratioClean = devRatio.map(v => v ?? 0);
		const zScore = buildRollingZScore(ratioClean, 50);

		return createSignalLoop(cleanData, [zScore], (i) => {
			if (i < 51) return null;
			const z = zScore[i];
			if (z === null) return null;

			const currAbsDev = Math.abs(devSeries[i]);
			const prevAbsDev = Math.abs(devSeries[i - 1]);

			if (z < -2.5 && currAbsDev < prevAbsDev) {
				return createBuySignal(cleanData, i, `Deviation ratio z-score extreme bearish (${z.toFixed(2)}), decelerating — fade long`);
			}
			if (z > 2.5 && currAbsDev < prevAbsDev) {
				return createSellSignal(cleanData, i, `Deviation ratio z-score extreme bullish (${z.toFixed(2)}), decelerating — fade short`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["fastWindow", "slowWindow"] } };
