import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildRollingZScore, extractBarMetricSeries } from "./price-action-statistics-core";

export const atr_gap_zscore_fade: Strategy = {
	name: "ATR Gap Z-Score Fade",
	description: "Targets extreme intraday or session opening gaps that vastly exceed the normalized physical volatility (ATR) of the asset, fading the shock instantly back toward the prior structural close.",
	defaultParams: {
		atrPeriod: 14,
		zscoreLookback: 50,
		gapZscoreThreshold: 3.0,
	},
	paramLabels: {
		atrPeriod: "ATR Period",
		zscoreLookback: "Z-Score Lookback",
		gapZscoreThreshold: "Z-Score Threshold",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const atrLen = Number(params.atrPeriod ?? 14);
		const lookback = Number(params.zscoreLookback ?? 50);
		const trigger = Number(params.gapZscoreThreshold ?? 3.0);

		if (cleanData.length < Math.max(atrLen, lookback)) return [];

		// Extract raw percentage gap (Open[i] - Close[i-1])/Close[i-1]
		const gapPct = extractBarMetricSeries(cleanData, 'gapPct');

		const zscore = buildRollingZScore(gapPct, lookback);

		return createSignalLoop(cleanData, [], (i) => {
			if (i < Math.max(atrLen, lookback) || zscore[i] === null) return null;

            const z = zscore[i]!;

            if (z < -trigger) {
                return createBuySignal(cleanData, i, "Extreme gap down outlier z-score fade");
            }

            if (z > trigger) {
                return createSellSignal(cleanData, i, "Extreme gap up outlier z-score fade");
            }

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["atrPeriod", "zscoreLookback", "gapZscoreThreshold"],
	},
};
