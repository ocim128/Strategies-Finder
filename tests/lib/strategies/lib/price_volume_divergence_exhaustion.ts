import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildRollingCorrelation, buildRateOfChange } from "./price-action-statistics-core";

function normalizePriceVolumeDivergenceExhaustionParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(params.lookback ?? 14)),
		correlation_max: -Math.abs(Number(params.correlation_max ?? -0.6)) };
}

export const price_volume_divergence_exhaustion: Strategy = {
	name: "Price Volume Divergence Exhaustion",
	description: "A strongly negative rolling correlation between price returns and volume indicates the directional move is losing institutional participation, favoring reversal.",
	defaultParams: {
		lookback: 14,
		correlation_max: -0.6 },
	paramLabels: {
		lookback: "Lookback",
		correlation_max: "Max Correlation" },
	normalizeParams: normalizePriceVolumeDivergenceExhaustionParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const p = normalizePriceVolumeDivergenceExhaustionParams(params);
		if (cleanData.length < p.lookback) return [];

		const closes = getCloses(cleanData);
		const volumes = getVolumes(cleanData);
		const roc = buildRateOfChange(closes, 1);
		const rocValues: number[] = new Array(cleanData.length).fill(0);
		for (let i = 0; i < cleanData.length; i++) {
			rocValues[i] = roc[i] ?? 0;
		}
		const correlation = buildRollingCorrelation(rocValues, volumes, p.lookback);

		return createSignalLoop(cleanData, [correlation], (i) => {
			if (i < 1 || i < p.lookback) return null;
			const corr = correlation[i];
			if (corr === null) return null;

			const currentRoc = rocValues[i];
			if (corr < p.correlation_max && currentRoc < 0) {
				return createBuySignal(cleanData, i, `Return-Vol corr ${corr.toFixed(3)} < ${p.correlation_max}, down move on fading volume`);
			}
			if (corr < p.correlation_max && currentRoc > 0) {
				return createSellSignal(cleanData, i, `Return-Vol corr ${corr.toFixed(3)} < ${p.correlation_max}, up move on fading volume`);
			}
			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "correlation_max"] } };
