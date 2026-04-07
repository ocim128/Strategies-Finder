import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getTypicalPrices } from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";
import { calculateVWAP } from "../indicators";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		z_lookback: Math.max(2, Math.round(params.z_lookback ?? 40)),
		z_thresh: Number(params.z_thresh ?? 2.5) };
}

export const typical_price_vwap_distance_zscore: Strategy = {
	name: "Typical Price VWAP Distance Z-Score",
	description: "Using Typical Price instead of Close removes end-of-bar gaming. A Z-score of the distance between Typical Price and VWAP catches pure intraday overextensions.",
	defaultParams: {
		z_lookback: 40,
		z_thresh: 2.5 },
	paramLabels: {
		z_lookback: "Z-Score Lookback",
		z_thresh: "Z-Score Threshold" },
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeParams(params);
		if (cleanData.length < normalizedParams.z_lookback) return [];

		const vwap = calculateVWAP(cleanData);
		const typicals = getTypicalPrices(cleanData);
		const distances = new Array(cleanData.length).fill(0);

		for (let i = 0; i < cleanData.length; i++) {
			if (vwap[i] === null) continue;
			distances[i] = typicals[i]! - vwap[i]!;
		}

		const zscores = buildRollingZScore(distances, normalizedParams.z_lookback);

		return createSignalLoop(cleanData, [vwap, zscores], (i) => {
			const z = zscores[i]!;

			if (z <= -normalizedParams.z_thresh) {
				return createBuySignal(cleanData, i, "Typical Price VWAP Z-score below -thresh");
			}

			if (z >= normalizedParams.z_thresh) {
				return createSellSignal(cleanData, i, "Typical Price VWAP Z-score above +thresh");
			}

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["z_lookback", "z_thresh"] } };
