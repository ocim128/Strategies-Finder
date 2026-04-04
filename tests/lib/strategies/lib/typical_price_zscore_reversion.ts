import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getTypicalPrices } from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(2, Math.round(params.lookback ?? 20)),
		z_thresh: Number(params.z_thresh ?? 2.5),
	};
}

export const typical_price_zscore_reversion: Strategy = {
	name: "Typical Price Z-Score Reversion",
	description: "Typical price (H+L+C)/3 captures true bar gravity; extreme z-score deviations from its own mean revert sharply.",
	defaultParams: {
		lookback: 20,
		z_thresh: 2.5,
	},
	paramLabels: {
		lookback: "Z-Score Lookback",
		z_thresh: "Z-Score Threshold",
	},
	normalizeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const normalizedParams = normalizeParams(params);
		if (cleanData.length < normalizedParams.lookback) return [];

		const typicals = getTypicalPrices(cleanData);
		const zscores = buildRollingZScore(typicals, normalizedParams.lookback);

		return createSignalLoop(cleanData, [zscores], (i) => {
			const z = zscores[i]!;

			if (z < -normalizedParams.z_thresh) {
				return createBuySignal(cleanData, i, "Typical Price Z-Score < -thresh");
			}

			if (z > normalizedParams.z_thresh) {
				return createSellSignal(cleanData, i, "Typical Price Z-Score > +thresh");
			}

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "z_thresh"],
	},
};
