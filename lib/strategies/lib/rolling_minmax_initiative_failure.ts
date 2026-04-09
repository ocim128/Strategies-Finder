import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildRollingMinMax, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeRollingMinmaxInitiativeFailureParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 30)) };
}

export const rolling_minmax_initiative_failure: Strategy = {
	name: "Rolling MinMax Initiative Failure",
	description: "Initiative pressure at its rolling extreme with opposing body direction signals maximum aggression fully absorbed — the strongest possible absorption signal. If the most aggressive initiative of the window can't move price, the contra-side liquidity is dominant. Fade the failed initiative.",
	defaultParams: {
		lookback: 30 },
	paramLabels: {
		lookback: "Lookback" },
	normalizeParams: normalizeRollingMinmaxInitiativeFailureParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeRollingMinmaxInitiativeFailureParams(params);
		const lookback = p.lookback as number;
		if (cleanData.length < lookback + 2) return [];

		const ipSeries = buildInitiativePressureSeries(cleanData, lookback);
		const ipClean = ipSeries.map(v => v ?? 0);
		const mm = buildRollingMinMax(ipClean, lookback);
		const bodyDir = extractBarMetricSeries(cleanData, "bodyDirection");

		return createSignalLoop(cleanData, [mm.min, mm.max], (i) => {
			if (i < lookback + 1) return null;
			const minVal = mm.min[i];
			const maxVal = mm.max[i];
			if (minVal === null || maxVal === null) return null;

			if (ipClean[i] === minVal && bodyDir[i] > 0) {
				return createBuySignal(cleanData, i, `IP at rolling minimum (${minVal.toFixed(4)}), body bullish — selling absorption`);
			}
			if (ipClean[i] === maxVal && bodyDir[i] < 0) {
				return createSellSignal(cleanData, i, `IP at rolling maximum (${maxVal.toFixed(4)}), body bearish — buying absorption`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback"] } };
