import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildDualTimeframeRatio } from "./price-action-statistics-core";

function normalizeDualTfVolumeConvictionParams(params: StrategyParams): StrategyParams {
	const fastWindow = Math.max(2, Math.round(params.fastWindow ?? 5));
	const slowWindow = Math.max(3, Math.round(params.slowWindow ?? 20));
	return {
		...params,
		fastWindow: Math.min(fastWindow, slowWindow - 1),
		slowWindow };
}

export const dual_tf_volume_conviction: Strategy = {
	name: "Dual Timeframe Volume Conviction",
	description: "When short-window volume average exceeds long-window average, participation intensity is accelerating. A directionally resolved bar confirms the move with institutional commitment.",
	defaultParams: {
		fastWindow: 5,
		slowWindow: 20 },
	paramLabels: {
		fastWindow: "Fast Window",
		slowWindow: "Slow Window" },
	normalizeParams: normalizeDualTfVolumeConvictionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeDualTfVolumeConvictionParams(params);
		if (cleanData.length < p.slowWindow) return [];

		const volumes = getVolumes(cleanData);
		const ratio = buildDualTimeframeRatio(volumes, p.fastWindow, p.slowWindow, buildRollingAverage);

		return createSignalLoop(cleanData, [ratio], (i) => {
			if (i < p.slowWindow) return null;
			const r = ratio[i];
			if (r === null) return null;

			if (r > 1.0 && cleanData[i].close > cleanData[i].open) {
				return createBuySignal(cleanData, i, `Volume ratio ${r.toFixed(3)} > 1.0, bullish bar with accelerating participation`);
			}
			if (r > 1.0 && cleanData[i].close < cleanData[i].open) {
				return createSellSignal(cleanData, i, `Volume ratio ${r.toFixed(3)} > 1.0, bearish bar with accelerating participation`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["fastWindow", "slowWindow"] } };
