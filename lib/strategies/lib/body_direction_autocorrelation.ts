import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { extractBarMetricSeries, buildRollingAutoCorrelation } from "./price-action-statistics-core";

function normalizeBodyDirectionAutocorrelationParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		autocorrWindow: Math.max(3, Math.round(params.autocorrWindow ?? 20)),
		autocorrThreshold: Math.max(0, Math.abs(Number(params.autocorrThreshold ?? 0.3))) };
}

export const body_direction_autocorrelation: Strategy = {
	name: "Body Direction Autocorrelation",
	description: "Autocorrelation of binary bar direction captures the market's bar-to-bar rhythm. Positive autocorrelation means trending (bars repeat direction); negative means oscillating (bars alternate). Trade with the identified rhythm regime.",
	defaultParams: {
		autocorrWindow: 20,
		autocorrThreshold: 0.3 },
	paramLabels: {
		autocorrWindow: "Autocorrelation Window",
		autocorrThreshold: "Autocorrelation Threshold" },
	normalizeParams: normalizeBodyDirectionAutocorrelationParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeBodyDirectionAutocorrelationParams(params);
		const window = p.autocorrWindow as number;
		const threshold = p.autocorrThreshold as number;
		if (cleanData.length < window + 2) return [];

		const bodyDir = extractBarMetricSeries(cleanData, "bodyDirection");
		const autocorr = buildRollingAutoCorrelation(bodyDir, window);

		return createSignalLoop(cleanData, [autocorr], (i) => {
			if (i < window) return null;
			const ac = autocorr[i];
			if (ac === null) return null;

			const dir = bodyDir[i];

			if (ac > threshold && dir > 0) {
				return createBuySignal(cleanData, i, `Trending rhythm (AC=${ac.toFixed(2)}), body bullish — go-with`);
			}
			if (ac > threshold && dir < 0) {
				return createSellSignal(cleanData, i, `Trending rhythm (AC=${ac.toFixed(2)}), body bearish — go-with`);
			}
			if (ac < -threshold && dir < 0) {
				return createBuySignal(cleanData, i, `Oscillating rhythm (AC=${ac.toFixed(2)}), body bearish — expect reversal`);
			}
			if (ac < -threshold && dir > 0) {
				return createSellSignal(cleanData, i, `Oscillating rhythm (AC=${ac.toFixed(2)}), body bullish — expect reversal`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["autocorrWindow", "autocorrThreshold"] } };
