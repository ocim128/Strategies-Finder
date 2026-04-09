import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildInitiativePressureSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeDualTimeframeInitiativePressureDivergenceParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		fastWindow: Math.max(2, Math.round(params.fastWindow ?? 5)),
		slowWindow: Math.max(2, Math.round(params.slowWindow ?? 40)) };
}

export const dual_timeframe_initiative_pressure_divergence: Strategy = {
	name: "Dual Timeframe Initiative Pressure Divergence",
	description: "Fast and slow windows of initiative pressure reveal whether short-term dealer aggression aligns with structural participation. When the fast/slow ratio reaches an extreme contra to slow direction, micro aggression is fighting the macro trend. Fade the fast spike.",
	defaultParams: {
		fastWindow: 5,
		slowWindow: 40 },
	paramLabels: {
		fastWindow: "Fast Window",
		slowWindow: "Slow Window" },
	normalizeParams: normalizeDualTimeframeInitiativePressureDivergenceParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeDualTimeframeInitiativePressureDivergenceParams(params);
		const fastWindow = p.fastWindow as number;
		const slowWindow = p.slowWindow as number;
		if (cleanData.length < Math.max(fastWindow, slowWindow) + 52) return [];

		const ipFast = buildInitiativePressureSeries(cleanData, fastWindow);
		const ipSlow = buildInitiativePressureSeries(cleanData, slowWindow);
		const ipFastClean = ipFast.map(v => v ?? 0);
		const ipSlowClean = ipSlow.map(v => v ?? 0);
		const fastAvg = buildRollingAverage(ipFastClean, fastWindow);
		const slowAvg = buildRollingAverage(ipSlowClean, slowWindow);

		const ratio: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			const f = fastAvg[i];
			const s = slowAvg[i];
			if (f !== null && s !== null && Math.abs(s) > 1e-9) {
				ratio[i] = f / s;
			}
		}

		const zScore = buildRollingZScore(ratio, 50);

		return createSignalLoop(cleanData, [zScore, slowAvg], (i) => {
			if (i < 51) return null;
			const z = zScore[i];
			const slowIp = slowAvg[i];
			if (z === null || slowIp === null) return null;

			if (z < -2.5 && slowIp > 0) {
				return createBuySignal(cleanData, i, `Fast IP ratio z-score extreme bearish (${z.toFixed(2)}), slow IP bullish — fade long`);
			}
			if (z > 2.5 && slowIp < 0) {
				return createSellSignal(cleanData, i, `Fast IP ratio z-score extreme bullish (${z.toFixed(2)}), slow IP bearish — fade short`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["fastWindow", "slowWindow"] } };
