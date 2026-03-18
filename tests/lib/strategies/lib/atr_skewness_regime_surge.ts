import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildPercentileRank, buildRollingSkewness } from "./price-action-statistics-core";

export const atr_skewness_regime_surge: Strategy = {
	name: "ATR Skewness Regime Surge",
	description: "Validates extreme physical market explosions uniquely by assessing the Percentile Rank of the ATR indicator directly overlaid strictly against the directional skewness representing cumulative sub-surface flow.",
	defaultParams: {
		atrPeriod: 14,
		rankLookback: 100,
		tailPercentile: 90,
	},
	paramLabels: {
		atrPeriod: "ATR Period",
		rankLookback: "Rank Lookback",
		tailPercentile: "Tail Percentile",
	},
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const atrLen = Number(params.atrPeriod ?? 14);
		const lookback = Number(params.rankLookback ?? 100);
		const pctTrigger = Number(params.tailPercentile ?? 90);

		if (cleanData.length < Math.max(atrLen, lookback)) return [];

		const atr = calculateATR(
			cleanData.map(d => d.high),
			cleanData.map(d => d.low),
			cleanData.map(d => d.close),
			atrLen
		);
		
		const cleanAtr = atr.map(a => a === null ? 0 : a);
		const rank = buildPercentileRank(cleanAtr, lookback); 
		const skewness = buildRollingSkewness(cleanData.map(d => d.close), lookback); 

		return createSignalLoop(cleanData, [], (i) => {
			if (i < 1 || rank[i] === null || skewness[i] === null) return null;

            const r = rank[i]!;
            const s = skewness[i]!;

            if (r > pctTrigger && s > 0.6) {
                return createBuySignal(cleanData, i, "ATR extreme percentile surge with positive skewness");
            }

            if (r > pctTrigger && s < -0.6) {
                return createSellSignal(cleanData, i, "ATR extreme percentile surge with negative skewness");
            }

			return null;
		});
	},
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["atrPeriod", "rankLookback", "tailPercentile"],
	},
};
