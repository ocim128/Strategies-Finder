import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
	createBuySignal,
	createSellSignal,
	createSignalLoop,
	ensureCleanData,
	getCloses,
	checkCrossover,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

type PreparedData = {
	data: OHLCVData[];
	closes: number[];
	closeLocation: number[];
	zscoreByLookback: Map<number, (number | null)[]>;
};

function normalizeParams(params: StrategyParams): StrategyParams {
	return {
		...params,
		lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
		zScoreLimit: Number(params.zScoreLimit ?? 2.0),
	};
}

export const rolling_median_crossover_reversion: Strategy = {
	name: "Rolling Median Crossover Reversion",
	description: "Fades price deviations when Z-score exceeds zScoreLimit and close location crosses 0.5 midpoint.",
	defaultParams: {
		lookback: 30,
		zScoreLimit: 2.0,
	},
	paramLabels: {
		lookback: "Lookback Window",
		zScoreLimit: "Z-Score Limit",
	},
	normalizeParams,
	prepareFinderData: (data) => ({
		data: data,
		closes: getCloses(data),
		closeLocation: buildCloseLocationSeries(data),
		zscoreByLookback: new Map<number, (number | null)[]>(),
	}),
	executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[]) => {
		const p = normalizeParams(params);
		const lookback = p.lookback as number;
		const zScoreLimit = p.zScoreLimit as number;

		const prepared = preparedData as PreparedData;
		const cleanData = prepared?.data ?? ensureCleanData(data);
		const len = cleanData.length;
		if (len < lookback + 2) return [];

		const closes = prepared?.closes ?? getCloses(cleanData);
		const closeLocation = prepared?.closeLocation ?? buildCloseLocationSeries(cleanData);

		const zscoreByLookback = prepared?.zscoreByLookback ?? new Map<number, (number | null)[]>();
		let zscore = zscoreByLookback.get(lookback);
		if (!zscore) {
			zscore = buildRollingZScore(closes, lookback);
			zscoreByLookback.set(lookback, zscore);
		}

		const thresholdArray = new Array(len).fill(0.5);

		return createSignalLoop(cleanData, [zscore], (i) => {
			if (i < lookback) return null;

			const z = zscore[i];
			if (z === null) return null;

			// Check close location crossover relative to 0.5
			const cross = checkCrossover(closeLocation, thresholdArray, i);

			if (z < -zScoreLimit && cross === "bullish") {
				return createBuySignal(cleanData, i, `Median crossover buy: Z ${z.toFixed(2)}, close location crossed above 0.5`);
			}
			if (z > zScoreLimit && cross === "bearish") {
				return createSellSignal(cleanData, i, `Median crossover sell: Z ${z.toFixed(2)}, close location crossed below 0.5`);
			}
			return null;
		});
	},
	execute: (data, params) =>
		rolling_median_crossover_reversion.executePrepared!(
			rolling_median_crossover_reversion.prepareFinderData!(data),
			params,
			data
		),
	metadata: {
		role: "entry",
		direction: "both",
		walkForwardParams: ["lookback", "zScoreLimit"],
	},
};
