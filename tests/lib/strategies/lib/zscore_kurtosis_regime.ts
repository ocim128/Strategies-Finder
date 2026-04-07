import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingZScore, buildRollingKurtosis } from "./price-action-statistics-core";

function normalizeZscoreKurtosisRegimeParams(params: StrategyParams): StrategyParams {
	const zscorePeriod = Math.max(2, Math.round(params.zscorePeriod ?? 20));
	const kurtosisLookback = Math.max(4, Math.round(params.kurtosisLookback ?? 30));
	const rawThreshold = Number(params.kurtosisThreshold ?? 3.0);
	const kurtosisThreshold = Math.max(0, Number.isFinite(rawThreshold) ? rawThreshold : 3.0);

	return {
		...params,
		zscorePeriod,
		kurtosisLookback,
		kurtosisThreshold };
}

export const zscore_kurtosis_regime: Strategy = {
	name: "ZScore Kurtosis Regime",
	description: "Z-score distribution kurtosis indicates regime: high kurtosis (fat tails) signals potential reversal; low kurtosis signals trending.",
	defaultParams: {
		zscorePeriod: 20,
		kurtosisLookback: 30,
		kurtosisThreshold: 3.0 },
	paramLabels: {
		zscorePeriod: "ZScore Period",
		kurtosisLookback: "Kurtosis Lookback",
		kurtosisThreshold: "Kurtosis Threshold" },
	normalizeParams: normalizeZscoreKurtosisRegimeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeZscoreKurtosisRegimeParams(params);
		const { zscorePeriod, kurtosisLookback, kurtosisThreshold } = normalizedParams;

		if (cleanData.length < zscorePeriod + kurtosisLookback) return [];

		const closes = getCloses(cleanData);
		const zscores = buildRollingZScore(closes, zscorePeriod);

		// Filter nulls for kurtosis calculation
		const validZscores: number[] = [];
		const indexMap: number[] = [];
		for (let i = 0; i < zscores.length; i++) {
			if (zscores[i] !== null) {
				validZscores.push(zscores[i]!);
				indexMap.push(i);
			}
		}

		const validKurtosis = buildRollingKurtosis(validZscores, kurtosisLookback);

		// Map back to full array
		const kurtosis: (number | null)[] = new Array(zscores.length).fill(null);
		for (let i = 0; i < validKurtosis.length; i++) {
			if (validKurtosis[i] !== null) {
				kurtosis[indexMap[i]!] = validKurtosis[i];
			}
		}

		return createSignalLoop(cleanData, [zscores, kurtosis], (i) => {
			const z = zscores[i];
			const k = kurtosis[i];

			if (z === null || k === null) return null;

			// High kurtosis (> threshold) = fat tails = reversion regime
			// Enter when zscore is extreme and starting to revert
			if (k > kurtosisThreshold) {
				// Mean reversion: short when zscore is very high, long when very low
				if (z > 1.5) {
					return createSellSignal(cleanData, i, `Fat tails (k=${k.toFixed(1)} > ${kurtosisThreshold}), zscore=${z.toFixed(2)} (reversion short)`);
				}
				if (z < -1.5) {
					return createBuySignal(cleanData, i, `Fat tails (k=${k.toFixed(1)} > ${kurtosisThreshold}), zscore=${z.toFixed(2)} (reversion long)`);
				}
			}

			// Low kurtosis (< threshold/2) = trending regime
			// Enter in direction of zscore
			if (k < kurtosisThreshold / 2) {
				if (z > 0.5) {
					return createBuySignal(cleanData, i, `Thin tails (k=${k.toFixed(1)}), zscore=${z.toFixed(2)} (trend long)`);
				}
				if (z < -0.5) {
					return createSellSignal(cleanData, i, `Thin tails (k=${k.toFixed(1)}), zscore=${z.toFixed(2)} (trend short)`);
				}
			}

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["zscorePeriod", "kurtosisLookback", "kurtosisThreshold"] } };