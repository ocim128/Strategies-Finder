import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildBodyPctSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildDualTimeframeRatio } from "./price-action-statistics-core";

function normalizeDualTimeframeBodyExpansionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		fastWindow: Math.max(2, Math.round(params.fastWindow ?? 5)),
		slowWindow: Math.max(2, Math.round(params.slowWindow ?? 20)) };
}

export const dual_timeframe_body_expansion: Strategy = {
	name: "Dual Timeframe Body Expansion",
	description: "When short-term body conviction exceeds long-term conviction (fast/slow ratio above 1), micro-level directional energy is building relative to macro. Confirmed by current bar body direction, this identifies momentum-building entries.",
	defaultParams: {
		fastWindow: 5,
		slowWindow: 20 },
	paramLabels: {
		fastWindow: "Fast Window",
		slowWindow: "Slow Window" },
	normalizeParams: normalizeDualTimeframeBodyExpansionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeDualTimeframeBodyExpansionParams(params);
		const fastWindow = p.fastWindow as number;
		const slowWindow = p.slowWindow as number;
		if (cleanData.length < slowWindow + 2) return [];

		const bodyPct = buildBodyPctSeries(cleanData);
		const ratio = buildDualTimeframeRatio(bodyPct, fastWindow, slowWindow, buildRollingAverage);

		return createSignalLoop(cleanData, [ratio], (i) => {
			if (i < slowWindow) return null;
			const r = ratio[i];
			if (r === null || r <= 1) return null;

			if (cleanData[i].close > cleanData[i].open) {
				return createBuySignal(cleanData, i, `Body conviction expanding (ratio ${r.toFixed(2)}), bar bullish`);
			}
			if (cleanData[i].close < cleanData[i].open) {
				return createSellSignal(cleanData, i, `Body conviction expanding (ratio ${r.toFixed(2)}), bar bearish`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["fastWindow", "slowWindow"] } };
