import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
	checkCrossover,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingSkewness, buildRollingZScore } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	returns: number[];
	zscoreByLookback: Map<number, (number | null)[]>;
	skewnessByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 45))),
		skewLimit: Number(params.skewLimit ?? 1.5),
	};
}

export const rolling_skewness_exhaustion_fade_v2: Strategy = {
	name: "Rolling Skewness Exhaustion Fade",
	description: "Fades price extremes when rolling return skewness crosses back from skewness limits (-skewLimit / skewLimit) towards zero.",
	defaultParams: {
		lookback: 45,
		skewLimit: 1.5,
	},
	paramLabels: {
		lookback: "Lookback Window",
		skewLimit: "Skew Limit",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		returns: extractBarMetricSeries(data, "closeReturn"),
		zscoreByLookback: new Map<number, (number | null)[]>(),
		skewnessByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const skewLimit = p.skewLimit as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		const len = cleanData.length;
		if (len < lookback + 2) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);
		const returns = prepared?.returns ?? extractBarMetricSeries(cleanData, "closeReturn");

		const zscoreByLookback = prepared?.zscoreByLookback ?? new Map<number, (number | null)[]>();
		let zscore = zscoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(closes, lookback);
			zscoreByLookback.set(lookback, zscore);
		}

		const skewnessByLookback = prepared?.skewnessByLookback ?? new Map<number, (number | null)[]>();
		let skew = skewnessByLookback.get(lookback);
		if (!skew) {
			skew = buildRollingSkewness(returns, lookback);
			skewnessByLookback.set(lookback, skew);
		}

		const thresholdArrayBuy = new Array(len).fill(-skewLimit);
		const thresholdArraySell = new Array(len).fill(skewLimit);

		return createSignalLoop(cleanData, [zscore, skew], (i) => {
			if (i < lookback) return null;

			const z = zscore[i];
			if (z === null) return null;

			// Check if skewness crosses back above -skewLimit (bullish cross)
			const crossBuy = checkCrossover(skew, thresholdArrayBuy, i);
			// Check if skewness crosses back below skewLimit (bearish cross)
			const crossSell = checkCrossover(skew, thresholdArraySell, i);

			if (z < -1.8 && crossBuy === "bullish") {
				return createBuySignal(cleanData, i, `Skewness buy: Z ${z.toFixed(2)}, skewness crossed above ${-skewLimit}`);
			}
			if (z > 1.8 && crossSell === "bearish") {
				return createSellSignal(cleanData, i, `Skewness sell: Z ${z.toFixed(2)}, skewness crossed below ${skewLimit}`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		rolling_skewness_exhaustion_fade_v2.executePrepared!(
			rolling_skewness_exhaustion_fade_v2.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "skewLimit"],
	},
};
