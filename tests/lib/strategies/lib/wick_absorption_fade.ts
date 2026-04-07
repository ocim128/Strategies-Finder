import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildUpperWickSeries, buildLowerWickSeries, buildRangeSeries, buildRollingAverage } from "./price-action-frequency-core";

function normalizeWickAbsorptionFadeParams(params: StrategyParams): StrategyParams {
	const lookback = Math.max(3, Math.round(params.lookback ?? 10));
	const absorptionRatio = Math.min(0.9, Math.max(0.5, Number(params.absorptionRatio ?? 0.7)));
	return { ...params, lookback, absorptionRatio };
}

export const wick_absorption_fade: Strategy = {
	name: "Wick Absorption Fade",
	description:
		"Over N bars, the ratio of total wick length to total range measures how much price movement was rejected. A very high ratio means bars are mostly wick — price keeps probing but getting pushed back. When wick dominance is extreme, the dominant wick direction identifies which side is absorbing, and a fade in the opposite direction captures the rejection flow.",
	defaultParams: { lookback: 10, absorptionRatio: 0.7 },
	paramLabels: { lookback: "Lookback", absorptionRatio: "Absorption Ratio" },
	normalizeParams: normalizeWickAbsorptionFadeParams,
	execute: (data: OHLCVData[], params: StrategyParams) => {
		const cleanData = ensureCleanData(data);
		const np = normalizeWickAbsorptionFadeParams(params);
		if (cleanData.length < np.lookback + 2) return [];
		const closes = getCloses(cleanData);
		const upperWicks = buildUpperWickSeries(cleanData);
		const lowerWicks = buildLowerWickSeries(cleanData);
		const ranges = buildRangeSeries(cleanData);
		const avgUpper = buildRollingAverage(upperWicks, np.lookback);
		const avgLower = buildRollingAverage(lowerWicks, np.lookback);
		const avgRange = buildRollingAverage(ranges, np.lookback);
		const lowerWickRatio: (number | null)[] = new Array(cleanData.length).fill(null);
		const upperWickRatio: (number | null)[] = new Array(cleanData.length).fill(null);
		for (let i = 0; i < cleanData.length; i++) {
			const ar = avgRange[i];
			if (ar === null || ar === 0) continue;
			const al = avgLower[i];
			const au = avgUpper[i];
			if (al !== null) lowerWickRatio[i] = al / ar;
			if (au !== null) upperWickRatio[i] = au / ar;
		}
		return createSignalLoop(cleanData, [lowerWickRatio, upperWickRatio], (i) => {
			const lr = lowerWickRatio[i];
			const ur = upperWickRatio[i];
			if (lr !== null && lr > np.absorptionRatio && closes[i] > closes[i - 1])
				return createBuySignal(cleanData, i, `Lower wick absorption ${lr.toFixed(3)} > ${np.absorptionRatio}`);
			if (ur !== null && ur > np.absorptionRatio && closes[i] < closes[i - 1])
				return createSellSignal(cleanData, i, `Upper wick absorption ${ur.toFixed(3)} > ${np.absorptionRatio}`);
			return null;
		});
	},
	metadata: { role: "entry", direction: "both", walkForwardParams: ["lookback", "absorptionRatio"] } };
