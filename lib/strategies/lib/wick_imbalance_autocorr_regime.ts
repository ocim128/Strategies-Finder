import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { extractBarMetricSeries, buildRollingAutoCorrelation, buildRollingZScore } from "./price-action-statistics-core";

function normalizeWickImbalanceAutocorrRegimeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		autocorrWindow: Math.max(3, Math.round(params.autocorrWindow ?? 20)),
		autocorrThreshold: Math.max(0, Math.abs(Number(params.autocorrThreshold ?? 0.4))) };
}

export const wick_imbalance_autocorr_regime: Strategy = {
	name: "Wick Imbalance Autocorrelation Regime",
	description: "Autocorrelation of wick imbalance reveals whether rejections are structured or random. When autocorrelation is extreme and imbalance z-score confirms, rejections are coordinated — fade the coordinated rejection as exhaustion.",
	defaultParams: {
		autocorrWindow: 20,
		autocorrThreshold: 0.4 },
	paramLabels: {
		autocorrWindow: "Autocorrelation Window",
		autocorrThreshold: "Autocorrelation Threshold" },
	normalizeParams: normalizeWickImbalanceAutocorrRegimeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizeWickImbalanceAutocorrRegimeParams(params);
		const window = p.autocorrWindow as number;
		const threshold = p.autocorrThreshold as number;
		if (cleanData.length < 52) return [];

		const closes = getCloses(cleanData);
		const wickImbalance = extractBarMetricSeries(cleanData, "wickImbalance");
		const autocorr = buildRollingAutoCorrelation(wickImbalance, window);
		const zScore = buildRollingZScore(wickImbalance, 50);
		const avgClose = buildRollingAverage(closes, window);

		return createSignalLoop(cleanData, [autocorr, zScore, avgClose], (i) => {
			if (i < 51) return null;
			const ac = autocorr[i];
			const z = zScore[i];
			const avg = avgClose[i];
			if (ac === null || z === null || avg === null) return null;
			if (Math.abs(ac) < threshold) return null;

			if (ac > threshold && z > 2.0 && closes[i] > avg) {
				return createBuySignal(cleanData, i, `Coordinated downward rejection exhausted (AC=${ac.toFixed(2)}, z=${z.toFixed(2)}), price refusing to follow`);
			}
			if (ac > threshold && z < -2.0 && closes[i] < avg) {
				return createSellSignal(cleanData, i, `Coordinated upward rejection exhausted (AC=${ac.toFixed(2)}, z=${z.toFixed(2)}), price refusing to follow`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["autocorrWindow", "autocorrThreshold"] } };
