import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildBodyPctSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildDualTimeframeRatio } from "./price-action-statistics-core";

function normalizeDualTfBodyConvictionParams(params: StrategyParams): StrategyParams {
	const fastWindow = Math.max(2, Math.round(params.fastWindow ?? 5));
	const slowWindow = Math.max(3, Math.round(params.slowWindow ?? 20));
	return {
		...params,
		fastWindow: Math.min(fastWindow, slowWindow - 1),
		slowWindow };
}

export const dual_tf_body_conviction: Strategy = {
	name: "Dual Timeframe Body Conviction",
	description: "When fast-window average body percentage exceeds slow-window average, short-term directional conviction is accelerating. Enter in the direction of the current bar when this conviction ratio is elevated.",
	defaultParams: {
		fastWindow: 5,
		slowWindow: 20 },
	paramLabels: {
		fastWindow: "Fast Window",
		slowWindow: "Slow Window" },
	normalizeParams: normalizeDualTfBodyConvictionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeDualTfBodyConvictionParams(params);
		if (cleanData.length < p.slowWindow) return [];

		const bodyPct = buildBodyPctSeries(cleanData);
		const ratio = buildDualTimeframeRatio(bodyPct, p.fastWindow, p.slowWindow, buildRollingAverage);

		return createSignalLoop(cleanData, [ratio], (i) => {
			if (i < 1 || i < p.slowWindow) return null;
			const r = ratio[i];
			if (r === null) return null;

			if (r > 1.0 && cleanData[i].close > cleanData[i - 1].close) {
				return createBuySignal(cleanData, i, `Body conviction ratio ${r.toFixed(3)} > 1.0, bullish accelerating`);
			}
			if (r > 1.0 && cleanData[i].close < cleanData[i - 1].close) {
				return createSellSignal(cleanData, i, `Body conviction ratio ${r.toFixed(3)} > 1.0, bearish accelerating`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["fastWindow", "slowWindow"] } };
